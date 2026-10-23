import { describe, expect, it } from "vite-plus/test";

import { ModelTurnedOff } from "@/ports/model-gateway.ts";

import { setup, type SpaceBody } from "./workspace.ts";

type Detail = { thread: { model: string | null; effort: string | null }; defaults: object };

describe("a space's defaults", () => {
  it("are set by its owner to a model the org can use, and go back to the org's", async () => {
    const { api, signUp, yourSpace, join, org } = setup();
    org.models.push("claude/claude-big");
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");
    const set = (cookie: string, body: object) =>
      api("PATCH", `/spaces/${space.id}/defaults`, cookie, body);

    const res = await set(ada.cookie, { model: "claude/claude-big", effort: "high" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      defaultModel: "claude/claude-big",
      defaultEffort: "high",
    });
    expect((await set(ada.cookie, { model: "claude/unknown" })).status).toBe(400);
    expect((await set(ada.cookie, { effort: "max" })).status).toBe(400);
    expect((await set(ada.cookie, {})).status).toBe(400);
    expect((await set(grace.cookie, { effort: "low" })).status).toBe(403);

    // A field left out is kept.
    const cleared = (await (await set(ada.cookie, { model: null })).json()) as SpaceBody;
    expect(cleared).toMatchObject({ defaultModel: null, defaultEffort: "high" });
  });

  it("start new threads, before the org's, and later changes leave those threads be", async () => {
    const { api, signUp, yourSpace, createThread, org } = setup();
    org.models.push("claude/claude-big");
    org.defaultModel = "codex/gpt-big";
    org.defaultEffort = "low";
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);

    const before = await createThread(ada.cookie, space.id);
    expect(before).toMatchObject({ model: "codex/gpt-big", effort: "low" });

    await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, {
      model: "claude/claude-big",
      effort: "high",
    });
    const after = await createThread(ada.cookie, space.id);
    expect(after).toMatchObject({ model: "claude/claude-big", effort: "high" });

    const detail = (await (await api("GET", `/threads/${before.id}`, ada.cookie)).json()) as Detail;
    expect(detail.thread).toMatchObject({ model: "codex/gpt-big", effort: "low" });
    expect(detail.defaults).toMatchObject({ model: "claude/claude-big", effort: "high" });
  });
});

describe("a new thread", () => {
  it("starts on the model and effort chosen for it, which must be one the org can use", async () => {
    const { api, signUp, yourSpace, org } = setup();
    org.models.push("claude/claude-big");
    org.defaultModel = "codex/gpt-big";
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    const start = (body: object) => api("POST", `/spaces/${space.id}/threads`, ada.cookie, body);

    const res = await start({ text: "Hi", model: "claude/claude-big", effort: "high" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ model: "claude/claude-big", effort: "high" });
    expect((await start({ text: "Hi", model: "claude/unknown" })).status).toBe(400);
    expect((await start({ text: "Hi", effort: "max" })).status).toBe(400);
  });
});

describe("a thread without a model or effort of its own", () => {
  it("follows its space's, then its org's, when the agent replies", async () => {
    const { api, signUp, yourSpace, createThread, org, model, worker } = setup();
    org.defaultModel = "codex/gpt-big";
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    const thread = await createThread(ada.cookie, space.id);
    worker.start();
    const efforts: (string | undefined)[] = [];
    async function reply() {
      await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi" });
      const call = await model.next();
      efforts.push(call.request.effort);
      call.reply("Hello");
      await worker.idle();
    }

    try {
      await reply();
      org.defaultEffort = "low";
      await reply();
      await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, { effort: "high" });
      await reply();
      await api("PATCH", `/threads/${thread.id}`, ada.cookie, { effort: "medium" });
      await reply();
    } finally {
      await worker.stop();
    }

    expect(efforts).toEqual([undefined, "low", "high", "medium"]);
  });

  it("goes back to following the defaults when its model is cleared", async () => {
    const { api, signUp, yourSpace, createThread, org } = setup();
    org.defaultModel = "codex/gpt-big";
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    const thread = await createThread(ada.cookie, space.id);

    const res = await api("PATCH", `/threads/${thread.id}`, ada.cookie, {
      model: null,
      effort: null,
    });
    expect(res.status).toBe(200);
    const detail = (await (await api("GET", `/threads/${thread.id}`, ada.cookie)).json()) as Detail;
    expect(detail.thread).toMatchObject({ model: null, effort: null });
    expect(detail.defaults).toMatchObject({ model: "codex/gpt-big", effort: null });
  });
});

describe("a thread whose model is turned off", () => {
  it("replies with its space's default, then its org's, and keeps its own for when it is back", async () => {
    const { api, signUp, yourSpace, createThread, org, model, worker, runStore, threadStore } =
      setup();
    org.defaultModel = "codex/gpt-big";
    org.models.push("claude/own", "claude/space");
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, { model: "claude/space" });
    const thread = await createThread(ada.cookie, space.id);
    await api("PATCH", `/threads/${thread.id}`, ada.cookie, { model: "claude/own" });
    const used: (string | null | undefined)[] = [];
    async function reply() {
      await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi" });
      (await model.next()).reply("Hello");
      await worker.idle();
      used.push(runStore.latest(thread.id)?.model);
    }

    worker.start();
    try {
      org.off = ["claude/own"];
      await reply();
      org.off = ["claude/own", "claude/space"];
      await reply();
      org.off = [];
      await reply();
    } finally {
      await worker.stop();
    }

    expect(used).toEqual(["claude/space", "codex/gpt-big", "claude/own"]);
    expect(threadStore.find(thread.id)?.model).toBe("claude/own");
  });

  it("replies at the effort that goes with the model used, not its own", async () => {
    const { api, signUp, yourSpace, createThread, org, model, worker } = setup();
    org.defaultModel = "codex/gpt-big";
    org.defaultEffort = "low";
    org.models.push("claude/own", "claude/space");
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, {
      model: "claude/space",
      effort: "medium",
    });
    const thread = await createThread(ada.cookie, space.id);
    await api("PATCH", `/threads/${thread.id}`, ada.cookie, {
      model: "claude/own",
      effort: "high",
    });
    const efforts: (string | undefined)[] = [];
    async function reply() {
      await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi" });
      const call = await model.next();
      efforts.push(call.request.effort);
      call.reply("Hello");
      await worker.idle();
    }

    worker.start();
    try {
      await reply();
      org.off = ["claude/own"];
      await reply();
      org.off = ["claude/own", "claude/space"];
      await reply();
    } finally {
      await worker.stop();
    }

    expect(efforts).toEqual(["high", "medium", "low"]);
  });

  it("shows the model and effort that reply instead", async () => {
    const { api, signUp, yourSpace, createThread, org } = setup();
    org.defaultModel = "codex/gpt-big";
    org.defaultEffort = "low";
    org.models.push("claude/own", "claude/space");
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, {
      model: "claude/space",
      effort: "medium",
    });
    const thread = await createThread(ada.cookie, space.id);
    await api("PATCH", `/threads/${thread.id}`, ada.cookie, {
      model: "claude/own",
      effort: "high",
    });
    const detail = async () =>
      (await (await api("GET", `/threads/${thread.id}`, ada.cookie)).json()) as {
        defaults: { used: { ref: string; effort: string | null } | null };
        model: { used: { ref: string } | null; effort: string | null };
      };

    expect(await detail()).toMatchObject({
      defaults: { used: { ref: "claude/space", effort: "medium" } },
      model: { used: { ref: "claude/own" }, effort: "high" },
    });
    org.off = ["claude/own", "claude/space"];
    expect(await detail()).toMatchObject({
      defaults: { used: { ref: "codex/gpt-big", effort: "low" } },
      model: { used: { ref: "codex/gpt-big" }, effort: "low" },
    });
  });

  it("fails its run saying why when nothing it could use is on", async () => {
    const { api, signUp, yourSpace, createThread, org, makeWorker, threadStore } = setup();
    org.defaultModel = "codex/gpt-big";
    org.off = ["codex/gpt-big"];
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    const thread = await createThread(ada.cookie, space.id);
    const worker = makeWorker({
      models: {
        replyModel: () => {
          const off = { ref: "codex/gpt-big", name: "GPT Big", status: "off" as const };
          return Promise.resolve({ chosen: off, used: null, effort: null });
        },
        open: () => Promise.reject(new ModelTurnedOff("GPT Big")),
      },
    });
    worker.start();
    try {
      await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi" });
      await worker.idle();
    } finally {
      await worker.stop();
    }

    const failed = threadStore.eventsAfter(thread.id, 0).find((e) => e.type === "run.failed");
    expect(failed?.data).toMatchObject({
      error: "Model GPT Big is turned off. Choose another model to continue.",
    });
  });
});

describe("a thread's defaults", () => {
  it("name the org's default while the space's is turned off", async () => {
    const { api, signUp, yourSpace, createThread, org } = setup();
    org.defaultModel = "codex/gpt-big";
    org.models.push("claude/space");
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await yourSpace(ada.cookie);
    await api("PATCH", `/spaces/${space.id}/defaults`, ada.cookie, { model: "claude/space" });
    const thread = await createThread(ada.cookie, space.id);
    const defaults = async () =>
      (
        (await (await api("GET", `/threads/${thread.id}`, ada.cookie)).json()) as {
          defaults: { model: string; used: { ref: string } | null };
        }
      ).defaults;

    expect(await defaults()).toMatchObject({
      model: "claude/space",
      used: { ref: "claude/space" },
    });
    org.off = ["claude/space"];
    expect(await defaults()).toMatchObject({
      model: "claude/space",
      used: { ref: "codex/gpt-big", name: "gpt-big" },
    });
  });
});
