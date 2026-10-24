import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/adapters/schema.ts";
import { decide, levelOf } from "@/services/tool-authority.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { agentThread } from "./agent-thread.ts";
import type { Call } from "./scripted-model.ts";

const run = "run" as const;
const approve = "approve" as const;

describe("levels", () => {
  it("come from how a person reaches the thread now, and the space's overrides", () => {
    const owner = { via: "space" as const, role: "owner" as const };
    const messager = { via: "space" as const, role: "messager" as const };
    const viewer = { via: "space" as const, role: "viewer" as const };
    const guest = { via: "guest" as const, spaceName: "Ada" };
    expect(levelOf(owner, "thread.move", { messager: approve })).toBe(run);
    expect(levelOf(messager, "thread.move")).toBe(run);
    expect(levelOf(messager, "thread.move", { messager: approve })).toBe(approve);
    expect(levelOf(viewer, "thread.move")).toBe(approve);
    expect(levelOf(guest, "thread.move")).toBe(approve);
    expect(levelOf(guest, "thread.info")).toBe(run);
    expect(levelOf(guest, "thread.move", { guest: run })).toBe(run);
    expect(levelOf(null, "thread.info")).toBe(approve);
  });
});

describe("deciding a call", () => {
  const cases: [string, Parameters<typeof decide>[0], ReturnType<typeof decide>][] = [
    [
      "owner alone, normal risk",
      { risk: "normal", influence: [{ seq: 1, level: run }], standing: [] },
      "run",
    ],
    [
      "someone at approve wrote earlier",
      {
        risk: "normal",
        influence: [
          { seq: 1, level: run },
          { seq: 2, level: approve },
        ],
        standing: [],
      },
      "wait",
    ],
    [
      "a standing approval after they wrote",
      {
        risk: "normal",
        influence: [{ seq: 2, level: approve }],
        standing: [{ atSeq: 5, level: run }],
      },
      "standing",
    ],
    [
      "they wrote after the standing approval",
      {
        risk: "normal",
        influence: [{ seq: 6, level: approve }],
        standing: [{ atSeq: 5, level: run }],
      },
      "wait",
    ],
    [
      "the approval's giver lost their level",
      {
        risk: "normal",
        influence: [{ seq: 2, level: approve }],
        standing: [{ atSeq: 5, level: approve }],
      },
      "wait",
    ],
    [
      "ask risk with the owner alone",
      { risk: "ask", influence: [{ seq: 1, level: run }], standing: [] },
      "wait",
    ],
    [
      "ask risk with a standing approval",
      { risk: "ask", influence: [{ seq: 1, level: run }], standing: [{ atSeq: 5, level: run }] },
      "wait",
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input)).toBe(expected);
  });
});

// The agent thread with a guest, Hedy, let into it, and helpers for tool calls.
async function toolThread() {
  const workspace = await agentThread();
  const { signUp, guestStore, thread, api, ada, events, model } = workspace;
  workspace.org.models = ["codex/gpt-big", "codex/gpt-small", "key-2/other"];
  const hedy = await signUp("Hedy Lamarr", "hedy@example.com");
  guestStore.grant({
    threadId: thread.id,
    userId: hedy.userId,
    invitedBy: ada.userId,
    accessUntil: null,
  });

  // The model's next call, asking for the tool calls in one step after a few words.
  async function calls(...asked: [string, unknown][]) {
    const call = await model.next();
    call.startStep();
    call.delta("On it.");
    for (const [index, [toolId, input]] of asked.entries()) {
      call.toolCall(`call-${model.calls.length}-${index}`, toolId, input);
    }
    call.endStep();
    call.end();
    return call;
  }
  function tools() {
    return transcriptOf(events()).rows.filter((row) => row.kind === "tool");
  }
  function decideCall(who: { cookie: string }, callId: string, allow: boolean, scope = "once") {
    return api("POST", `/threads/${thread.id}/tools/${callId}/decision`, who.cookie, {
      allow,
      scope,
    });
  }
  function setRole(userId: string, role: "owner" | "messager" | "viewer") {
    workspace.db
      .update(schema.spaceMember)
      .set({ role })
      .where(
        and(
          eq(schema.spaceMember.spaceId, workspace.space.id),
          eq(schema.spaceMember.subjectId, userId),
        ),
      )
      .run();
  }
  return { ...workspace, hedy, calls, tools, decideCall, setRole };
}

async function answered(call: Promise<Call>, text = "Done.") {
  const next = await call;
  next.reply(text);
  return next;
}

describe("tool calls", () => {
  it("run at once when everyone the model read may run them, before the next reply", async () => {
    const { ada, post, calls, model, worker, start, threadStore, thread, transcript, types } =
      await toolThread();
    start();

    await post(ada, "Name this thread");
    const first = await calls(["thread.rename", { title: "Engines" }]);
    const second = await answered(model.next(), "Renamed.");
    await worker.idle();

    expect(first.tools).toEqual([
      "thread.info",
      "thread.rename",
      "thread.move",
      "thread.set_model",
    ]);
    expect(threadStore.find(thread.id)?.title).toBe("Engines");
    expect(transcript()).toEqual([
      "Ada Lovelace: Name this thread",
      "Agent (completed): On it.",
      "thread.rename (ran)",
      "Agent (completed): Renamed.",
    ]);
    expect(types()).toContain("thread.renamed");
    expect(types().indexOf("tool.ran")).toBeLessThan(types().lastIndexOf("message.started"));
    expect(second.texts).toEqual([
      "user: [Ada Lovelace] Name this thread",
      "assistant: On it.",
      'tool thread.rename: {"title":"Engines"}',
      'result thread.rename: {"ok":true,"value":{"title":"Engines"}}',
    ]);
  });

  it("fail at once with input the tool does not take, and say which folders there are", async () => {
    const { ada, post, calls, model, worker, start, createFolder, space, tools } =
      await toolThread();
    await createFolder(ada.cookie, space.id, "Research");
    start();

    await post(ada, "Move it");
    await calls(["thread.rename", { name: "x" }], ["thread.move", { folder: "Nowhere" }]);
    const next = await answered(model.next());
    await worker.idle();

    expect(tools().map((row) => row.state)).toEqual(["failed", "failed"]);
    expect(next.texts.at(-2)).toContain("The input is not valid");
    expect(next.texts.at(-1)).toContain("The folders here: Research.");
  });

  it("wait for a decision when someone who needs approval wrote, letting the lease go", async () => {
    const workspace = await toolThread();
    const { ada, hedy, grace, post, calls, model, runStore, thread, makeWorker, start } = workspace;
    const first = makeWorker();
    start(first);
    await post(hedy, "Please move this to Research");
    await workspace.createFolder(ada.cookie, workspace.space.id, "Research");
    await calls(["thread.move", { folder: "Research" }]);
    await first.idle();

    const waiting = runStore.active(thread.id);
    expect(waiting).toMatchObject({ status: "waiting", leaseOwner: null });
    expect(workspace.transcript().at(-1)).toBe("thread.move (pending)");
    expect(transcriptOf(workspace.events()).run?.waitingOn).toBe(workspace.tools()[0]!.id);

    // A restart leaves a waiting run be.
    await first.stop();
    const second = makeWorker();
    second.recover();
    expect(runStore.active(thread.id)?.status).toBe("waiting");
    start(second);

    const callId = workspace.tools()[0]!.id;
    expect((await workspace.decideCall(grace, callId, true)).status).toBe(200);
    expect((await workspace.decideCall(ada, callId, false)).status).toBe(409);
    const next = await answered(model.next());
    await second.idle();

    expect(workspace.transcript().slice(-2)).toEqual([
      "thread.move (ran by Grace Hopper)",
      "Agent (completed): Done.",
    ]);
    expect(next.texts.at(-1)).toBe('result thread.move: {"ok":true,"value":{"folder":"Research"}}');
    expect(workspace.threadStore.find(thread.id)?.folderId).not.toBeNull();
  });

  it("refuse decisions from guests and viewers", async () => {
    const { hedy, alan, post, calls, worker, start, tools, decideCall } = await toolThread();
    start();
    await post(hedy, "Rename it to Looms");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    const callId = tools()[0]!.id;
    expect((await decideCall(hedy, callId, true)).status).toBe(403);
    expect((await decideCall(alan, callId, true)).status).toBe(403);
  });

  it("deny a call whose approval no longer holds, and tell the model it was not approved", async () => {
    const { hedy, grace, post, calls, model, start, makeWorker, tools, decideCall, setRole } =
      await toolThread();
    const first = makeWorker();
    start(first);
    await post(hedy, "Rename it to Looms");
    await calls(["thread.rename", { title: "Looms" }]);
    await first.idle();
    await first.stop();

    // Grace approves, then is made a viewer before the run goes on.
    expect((await decideCall(grace, tools()[0]!.id, true)).status).toBe(200);
    setRole(grace.userId, "viewer");
    const second = makeWorker();
    start(second);
    const next = await answered(model.next());
    await second.idle();

    expect(tools().map((row) => row.state)).toEqual(["stale"]);
    expect(next.texts.at(-1)).toBe(
      'result thread.rename: {"ok":false,"error":"This action was not approved."}',
    );
  });

  it("take in a steer on resuming, which can make an approval no longer hold", async () => {
    const { ada, hedy, post, calls, model, start, worker, tools, decideCall, transcript } =
      await toolThread();
    start();
    await post(ada, "Use the other provider");
    await calls(["thread.set_model", { model: "key-2/other", effort: null }]);
    await worker.idle();
    expect(tools()[0]).toMatchObject({ risk: "ask", state: "pending" });

    await post(hedy, "Actually, do not");
    expect((await decideCall(ada, tools()[0]!.id, true)).status).toBe(200);
    await answered(model.next());
    await worker.idle();

    expect(transcript()).toEqual([
      "Ada Lovelace: Use the other provider",
      "Agent (completed): On it.",
      "thread.set_model (stale by Ada Lovelace)",
      "Hedy Lamarr: Actually, do not",
      "Agent (completed): Done.",
    ]);
  });

  it("are denied as stopped when an interrupt ends the waiting run", async () => {
    const { ada, hedy, post, calls, model, start, worker, tools, transcript, runs } =
      await toolThread();
    start();
    await post(hedy, "Rename it to Looms");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    await post(ada, "Never mind, start over", "interrupt");
    await answered(model.next(), "Starting over.");
    await worker.idle();

    expect(tools().map((row) => row.state)).toEqual(["stopped"]);
    expect(transcript().slice(-3)).toEqual([
      "stopped by Ada Lovelace",
      "Ada Lovelace: Never mind, start over",
      "Agent (completed): Starting over.",
    ]);
    expect(runs().map((row) => row.status)).toEqual(["cancelled", "completed"]);
  });

  it("run without a card once allowed for now, until someone who needs approval writes", async () => {
    const workspace = await toolThread();
    const { ada, hedy, post, calls, model, start, worker, tools, decideCall } = workspace;
    start();
    await post(hedy, "Rename it");
    await calls(["thread.rename", { title: "One" }]);
    await worker.idle();
    expect((await decideCall(ada, tools()[0]!.id, true, "for_now")).status).toBe(200);
    await answered(model.next());
    await worker.idle();

    await post(ada, "Again");
    await calls(["thread.rename", { title: "Two" }]);
    await answered(model.next());
    await worker.idle();
    expect(tools().map((row) => row.state)).toEqual(["ran", "ran"]);
    expect(tools()[1]!.waits).toBe(false);

    await post(hedy, "And again");
    await calls(["thread.rename", { title: "Three" }]);
    await worker.idle();
    expect(tools()[2]).toMatchObject({ state: "pending", waits: true });
  });

  it("never let an approval for now cover a call that asks every time", async () => {
    const { ada, post, calls, worker, start, tools, decideCall } = await toolThread();
    start();
    await post(ada, "Switch providers");
    await calls(["thread.set_model", { model: "key-2/other", effort: "low" }]);
    await worker.idle();

    expect((await decideCall(ada, tools()[0]!.id, true, "for_now")).status).toBe(400);
  });

  it("let thread.info run for guests", async () => {
    const { hedy, post, calls, model, worker, start, tools } = await toolThread();
    start();
    await post(hedy, "What is this thread?");
    await calls(["thread.info", {}]);
    const next = await answered(model.next());
    await worker.idle();

    expect(tools().map((row) => row.state)).toEqual(["ran"]);
    expect(next.texts.at(-1)).toContain('"people":[{"name":"Hedy Lamarr","guest":true}]');
  });

  it("change the model the next reply is written with", async () => {
    const { ada, post, calls, model, worker, start, events } = await toolThread();
    start();
    await post(ada, "Use the small one");
    const first = await calls(["thread.set_model", { model: "codex/gpt-small", effort: "low" }]);
    const second = await answered(model.next());
    await worker.idle();

    const started = events().filter((event) => event.type === "message.started");
    expect(started.map((event) => (event.data as { model?: string }).model)).toEqual([
      "codex/gpt-big",
      "codex/gpt-small",
    ]);
    expect(first.request.effort).toBeUndefined();
    expect(second.request.effort).toBe("low");
  });

  it("are not offered where the org or the space turned them off", async () => {
    const workspace = await toolThread();
    const { ada, post, model, worker, start, toolSettings, space } = workspace;
    toolSettings.setInOrg(ada.orgId, "thread.info", false);
    toolSettings.setInSpace(space.id, "thread.move", { enabled: false });
    start();
    await post(ada, "Hello");
    const call = await answered(model.next());
    await worker.idle();
    expect(call.tools).toEqual(["thread.rename", "thread.set_model"]);

    const other = await workspace.createSpace(ada.cookie, "Other");
    const thread = await workspace.createThread(ada.cookie, other.id, "Hello there");
    const elsewhere = await answered(model.next());
    await worker.idle();
    expect(thread.id).toBeDefined();
    expect(elsewhere.tools).toEqual(["thread.rename", "thread.move", "thread.set_model"]);
  });
});

describe("tool settings", () => {
  it("let org owners turn tools off, and spaces only narrow what the org allows", async () => {
    const { ada, grace, api, space } = await toolThread();

    expect(
      (await api("PATCH", "/org/tools", grace.cookie, { toolId: "thread.move", enabled: false }))
        .status,
    ).toBe(403);
    const org = await api("PATCH", "/org/tools", ada.cookie, {
      toolId: "thread.move",
      enabled: false,
    });
    expect(await org.json()).toContainEqual({ id: "thread.move", enabled: false });

    const changed = await api("PATCH", `/spaces/${space.id}/tools`, ada.cookie, {
      toolId: "thread.rename",
      messager: "approve",
      guest: "run",
    });
    expect(await changed.json()).toEqual(
      expect.arrayContaining([
        { id: "thread.move", enabled: true, orgEnabled: false, messager: "run", guest: "approve" },
        { id: "thread.rename", enabled: true, orgEnabled: true, messager: "approve", guest: "run" },
        { id: "thread.info", enabled: true, orgEnabled: true, messager: "run", guest: "run" },
      ]),
    );
    expect((await api("GET", `/spaces/${space.id}/tools`, grace.cookie)).status).toBe(403);
  });
});

describe("thread lists", () => {
  it("say when the agent waits for a decision, and on which tool", async () => {
    const { ada, hedy, post, calls, worker, start, api, space, thread } = await toolThread();
    start();
    await post(hedy, "Rename it");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    const list = (await (await api("GET", `/spaces/${space.id}/threads`, ada.cookie)).json()) as {
      id: string;
      activity: unknown;
    }[];
    expect(list.find((item) => item.id === thread.id)?.activity).toMatchObject({
      kind: "waiting",
      toolId: "thread.rename",
    });
    const shared = (await (await api("GET", "/shared-threads", hedy.cookie)).json()) as {
      activity: unknown;
    }[];
    expect(shared[0]?.activity).toMatchObject({ kind: "waiting" });
  });
});
