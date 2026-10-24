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
  it("let anyone who can message in the thread run tools, and nobody else", () => {
    expect(levelOf({ via: "space", role: "owner" })).toBe(run);
    expect(levelOf({ via: "space", role: "messager" })).toBe(run);
    expect(levelOf({ via: "guest", spaceName: "Ada" })).toBe(run);
    expect(levelOf({ via: "space", role: "viewer" })).toBe(approve);
    expect(levelOf(null)).toBe(approve);
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
  // Hedy's access ends, so what she wrote now needs approval.
  function revokeHedy() {
    guestStore.revoke(thread.id, hedy.userId, ada.userId, new Date());
  }
  return { ...workspace, hedy, calls, tools, decideCall, setRole, revokeHedy };
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

  it("wait for a decision when someone who can no longer message wrote, letting the lease go", async () => {
    const workspace = await toolThread();
    const { ada, hedy, grace, post, calls, model, runStore, thread, makeWorker, start } = workspace;
    const first = makeWorker();
    start(first);
    await post(hedy, "Please move this to Research");
    workspace.revokeHedy();
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

  it("refuse decisions from viewers and people whose access ended", async () => {
    const { hedy, alan, post, calls, worker, start, tools, decideCall, revokeHedy } =
      await toolThread();
    start();
    await post(hedy, "Rename it to Looms");
    revokeHedy();
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    const callId = tools()[0]!.id;
    expect((await decideCall(hedy, callId, true)).status).toBe(410);
    expect((await decideCall(alan, callId, true)).status).toBe(403);
  });

  it("deny a call whose approval no longer holds, and tell the model it was not approved", async () => {
    const workspace = await toolThread();
    const { hedy, grace, post, calls, model, start, makeWorker, tools, decideCall, setRole } =
      workspace;
    const first = makeWorker();
    start(first);
    await post(hedy, "Rename it to Looms");
    workspace.revokeHedy();
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

  it("take in a steer on resuming, before the approved call runs", async () => {
    const { ada, hedy, post, calls, model, start, worker, tools, decideCall, transcript } =
      await toolThread();
    start();
    await post(ada, "Use the other provider");
    await calls(["thread.set_model", { model: "key-2/other", effort: null }]);
    await worker.idle();
    expect(tools()[0]).toMatchObject({ risk: "ask", state: "pending" });

    await post(hedy, "Then name it Looms");
    expect((await decideCall(ada, tools()[0]!.id, true)).status).toBe(200);
    const next = await answered(model.next());
    await worker.idle();

    expect(transcript()).toEqual([
      "Ada Lovelace: Use the other provider",
      "Agent (completed): On it.",
      "thread.set_model (ran by Ada Lovelace)",
      "Hedy Lamarr: Then name it Looms",
      "Agent (completed): Done.",
    ]);
    expect(next.texts.at(-1)).toBe("user: [Hedy Lamarr] Then name it Looms");
  });

  it("are denied as stopped when an interrupt ends the waiting run", async () => {
    const workspace = await toolThread();
    const { ada, hedy, post, calls, model, start, worker, tools, transcript, runs } = workspace;
    start();
    await post(hedy, "Rename it to Looms");
    workspace.revokeHedy();
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
    const { ada, hedy, grace, post, calls, model, start, worker, tools, decideCall, setRole } =
      workspace;
    start();
    await post(hedy, "Rename it");
    workspace.revokeHedy();
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

    await post(grace, "And again");
    setRole(grace.userId, "viewer");
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

  it("ask every time where the tool is set to ask, never for now", async () => {
    const { ada, post, calls, model, worker, start, tools, decideCall, toolSettings, space } =
      await toolThread();
    toolSettings.setInSpace(space.id, ["thread.rename"], "ask");
    start();
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    expect(tools()[0]).toMatchObject({ risk: "ask", state: "pending", waits: true });
    expect((await decideCall(ada, tools()[0]!.id, true, "for_now")).status).toBe(400);
    expect((await decideCall(ada, tools()[0]!.id, true)).status).toBe(200);
    await answered(model.next());
    await worker.idle();
    expect(tools().map((row) => row.state)).toEqual(["ran"]);
  });

  it("let guests run them, as anyone who can message", async () => {
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

  it("are not offered where the org or the space blocked them", async () => {
    const workspace = await toolThread();
    const { ada, post, model, worker, start, toolSettings, space } = workspace;
    toolSettings.setInOrg(ada.orgId, ["thread.info"], "block");
    toolSettings.setInSpace(space.id, ["thread.move"], "block");
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
  it("let org owners set each tool, and spaces only make it stricter", async () => {
    const { ada, grace, api, space } = await toolThread();
    const change = (toolIds: string[], mode: string) => ({ toolIds, mode });

    expect(
      (await api("PATCH", "/org/tools", grace.cookie, change(["thread.move"], "ask"))).status,
    ).toBe(403);
    expect(
      (await api("PATCH", "/org/tools", ada.cookie, change(["thread.nope"], "ask"))).status,
    ).toBe(404);
    const org = await api("PATCH", "/org/tools", ada.cookie, change(["thread.move"], "ask"));
    const [thread] = (await org.json()) as {
      id: string;
      title: string;
      source: string;
      tools: unknown[];
    }[];
    expect(thread).toMatchObject({ id: "thread", title: "Thread", source: "builtin" });
    expect(thread!.tools).toContainEqual(
      expect.objectContaining({ id: "thread.move", orgMode: "ask", mode: "ask" }),
    );
    expect(thread!.tools).toContainEqual(
      expect.objectContaining({
        id: "thread.info",
        mode: "allow",
        definition: expect.objectContaining({ annotations: { readOnlyHint: true } }),
      }),
    );

    await api("PATCH", `/spaces/${space.id}/tools`, ada.cookie, change(["thread.move"], "allow"));
    const changed = await api(
      "PATCH",
      `/spaces/${space.id}/tools`,
      ada.cookie,
      change(["thread.rename", "thread.info"], "block"),
    );
    const [inSpace] = (await changed.json()) as { tools: unknown[] }[];
    expect(inSpace!.tools).toEqual([
      expect.objectContaining({ id: "thread.info", orgMode: "allow", mode: "block" }),
      expect.objectContaining({ id: "thread.rename", orgMode: "allow", mode: "block" }),
      expect.objectContaining({ id: "thread.move", orgMode: "ask", mode: "ask" }),
      expect.objectContaining({ id: "thread.set_model", orgMode: "allow", mode: "allow" }),
    ]);
    expect((await api("GET", `/spaces/${space.id}/tools`, grace.cookie)).status).toBe(403);
  });
});

describe("thread lists", () => {
  it("say when the agent waits for a decision, on which tool, and who may make it", async () => {
    const { ada, alan, hedy, post, calls, worker, start, api, space, thread, toolSettings } =
      await toolThread();
    toolSettings.setInSpace(space.id, ["thread.rename"], "ask");
    start();
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    const activityFor = async (who: { cookie: string }) => {
      const list = (await (await api("GET", `/spaces/${space.id}/threads`, who.cookie)).json()) as {
        id: string;
        activity: unknown;
      }[];
      return list.find((item) => item.id === thread.id)?.activity;
    };
    expect(await activityFor(ada)).toMatchObject({
      run: { status: "waiting", toolId: "thread.rename" },
      canApprove: true,
    });
    expect(await activityFor(alan)).toMatchObject({ canApprove: false });
    const shared = (await (await api("GET", "/shared-threads", hedy.cookie)).json()) as {
      activity: unknown;
    }[];
    expect(shared[0]?.activity).toMatchObject({ run: { status: "waiting" }, canApprove: true });
  });

  it("list a thread waiting for a decision as needing only those who may make it", async () => {
    const { ada, alan, hedy, post, calls, worker, start, api, space, thread, toolSettings } =
      await toolThread();
    toolSettings.setInSpace(space.id, ["thread.rename"], "ask");
    start();
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    const needing = async (who: { cookie: string }, path: string) =>
      (await (await api("GET", `${path}?show=needs-you`, who.cookie)).json()) as {
        items: { id: string }[];
        total: number;
      };
    const sidebar = async (who: { cookie: string }) =>
      (await (await api("GET", `/spaces/${space.id}/threads/sidebar`, who.cookie)).json()) as {
        needsYou: number;
      };
    const page = `/spaces/${space.id}/threads/page`;
    expect(await needing(ada, page)).toMatchObject({ items: [{ id: thread.id }], total: 1 });
    expect(await needing(alan, page)).toMatchObject({ items: [], total: 0 });
    expect(await needing(hedy, "/shared-threads/page")).toMatchObject({ total: 1 });
    expect((await sidebar(ada)).needsYou).toBe(1);
    expect((await sidebar(alan)).needsYou).toBe(0);
  });
});
