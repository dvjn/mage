import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import * as schema from "@/server/schema.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";
import { EDITORS, TOOL_OFF, WIRE_NAME_MAX, wireToolName } from "@/shared/tools.ts";
import { transcriptOf } from "@/shared/transcript.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import type { Call } from "@/server/testing/scripted-model.ts";
import type { ThreadFollowItem } from "@/server/threads/service.ts";

import {
  createTools,
  definitionOf,
  modelToolNames,
  modelToolOf,
  type ToolPolicyFields,
  type Toolset,
} from "./tools.ts";
import {
  canPostIn,
  canUse as canUseUnder,
  type Decision,
  decide as decideUnder,
  type Influence,
  latestAuthor,
  mayApprove as mayApproveUnder,
  NOBODY,
  OPEN,
  type Person,
  personOf,
  type Rule,
  ruleFor,
  riskOf as riskUnder,
} from "./tool-authority.ts";

// The checks over a tool's policies, each collapsed into the one rule the tool is used under.
const canUse = (person: Person, rules: Rule[]) => canUseUnder(person, ruleFor(rules));
const mayApprove = (person: Person, rules: Rule[], risk: ToolRisk, latest: string | null) =>
  mayApproveUnder(person, ruleFor(rules), risk, latest);
const riskOf = (declared: ToolRisk, rules: Rule[]) => riskUnder(declared, ruleFor(rules));
const decide = ({
  rules,
  ...input
}: Omit<Parameters<typeof decideUnder>[0], "rule"> & { rules: Rule[] }) =>
  decideUnder({ ...input, rule: ruleFor(rules) });

// The tools the agent of a thread that can start subagents has for them.
const SUBAGENT_TOOLS = [
  "subagents.start",
  "subagents.send",
  "subagents.list",
  "subagents.watch",
  "subagents.stop",
  "subagents.archive",
  "subagents.unarchive",
];

const run = true;
const approve = false;

describe("a tool as the model is told about it", () => {
  it("leaves out the labels its schema carries for people, at every level", () => {
    const spec = {
      name: "notes.add",
      title: "Add note",
      description: "Add a note.",
      input: z.object({
        title: z.string().meta({ title: "Title", description: "What it is called" }),
        tags: z.array(z.object({ name: z.string().meta({ title: "Tag" }) })).optional(),
      }),
      risk: () => "normal" as const,
      run: () => Promise.resolve({ ok: true as const, value: null }),
    };
    const { inputSchema } = modelToolOf(spec);
    const sent = JSON.stringify(inputSchema);
    expect(sent).not.toContain("$schema");
    expect(sent).not.toMatch(/"title":"/);
    expect(inputSchema).toMatchObject({
      properties: {
        title: { type: "string", description: "What it is called" },
        tags: { items: { properties: { name: { type: "string" } } } },
      },
      required: ["title"],
    });
    expect(definitionOf(spec).inputSchema).toHaveProperty("$schema");
  });

  it("moves choices between whole inputs, which providers refuse, into the description", () => {
    const choice = { oneOf: [{ required: ["a"] }, { required: ["b"] }] };
    const { inputSchema, description } = modelToolOf({
      name: "workouts.replace",
      description: "Replace a workout.",
      input: z.object({}),
      inputSchema: {
        type: "object",
        ...choice,
        properties: { a: { type: "string" }, b: { type: "object", ...choice } },
      },
      risk: () => "normal" as const,
      run: () => Promise.resolve({ ok: true as const, value: null }),
    });
    expect(inputSchema).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "object", ...choice } },
    });
    expect(description).toBe(
      "Input constraint: Provide parameters for exactly one of: (a) or (b).\n\nReplace a workout.",
    );
  });
});

describe("levels", () => {
  it("let anyone who can message in the thread run tools, and nobody else", () => {
    expect(canPostIn({ via: "space", role: "owner" })).toBe(run);
    expect(canPostIn({ via: "space", role: "messager" })).toBe(run);
    expect(canPostIn({ via: "guest", spaceName: "Ada" })).toBe(run);
    expect(canPostIn({ via: "space", role: "viewer" })).toBe(approve);
    expect(canPostIn(null)).toBe(approve);
  });
});

function rule(fields: Partial<Rule>): Rule {
  return { ...NOBODY, ...fields };
}

describe("policy evaluation", () => {
  const ada = personOf("ada", run, ["eng"]);
  const grace = personOf("grace", run, ["sec"]);
  const alan = personOf("alan", approve, ["eng", "sec"]);
  const engineering = rule({ use: "some", users: ["group:eng"], approvers: ["group:sec"] });

  it("lets people use a tool directly only when every rule names them, never viewers", () => {
    expect(canUse(ada, [OPEN])).toBe(true);
    expect(canUse(alan, [OPEN])).toBe(false);
    expect(canUse(ada, [engineering])).toBe(true);
    expect(canUse(grace, [engineering])).toBe(false);
    expect(canUse(alan, [engineering])).toBe(false);
    expect(canUse(ada, [rule({ use: "some", users: ["user:ada"] })])).toBe(true);
    expect(canUse(ada, [OPEN, rule({ use: "none", approvers: [EDITORS] })])).toBe(false);
    // A space's extra rule narrows the org's: both must let them.
    expect(canUse(ada, [engineering, rule({ use: "some", users: ["user:grace"] })])).toBe(false);
  });

  it("lets only named approvers who can edit the thread approve, and anyone who can when none asks", () => {
    expect(mayApprove(grace, [engineering], "normal", null)).toBe(true);
    expect(mayApprove(ada, [engineering], "normal", null)).toBe(false);
    expect(mayApprove(alan, [engineering], "normal", null)).toBe(false);
    expect(mayApprove(ada, [OPEN], "ask", null)).toBe(true);
    expect(mayApprove(alan, [OPEN], "ask", null)).toBe(false);
    expect(mayApprove(ada, [rule({ approvers: [EDITORS] })], "ask", null)).toBe(true);
    // Every rule that asks must name them.
    const both = [engineering, rule({ approvers: ["user:ada"] })];
    expect(mayApprove(grace, both, "ask", null)).toBe(false);
    expect(mayApprove(personOf("maya", run, ["sec"]), both, "ask", null)).toBe(false);
    expect(mayApprove(personOf("ada", run, ["sec"]), both, "ask", null)).toBe(true);
  });

  it("never matches a stale id, and leaves calls with nobody to approve them", () => {
    const gone = rule({ use: "some", users: ["group:gone"], approvers: ["user:gone"] });
    expect(canUse(ada, [gone])).toBe(false);
    expect(mayApprove(ada, [gone], "normal", null)).toBe(false);
    expect(mayApprove(ada, [NOBODY], "ask", null)).toBe(false);
    expect(mayApprove(ada, [rule({ approvers: [] })], "ask", null)).toBe(false);
  });

  it("keeps the author of the latest human message from approving independently", () => {
    const rows = [
      { kind: "human", seq: 1, author: { userId: "ada" } },
      { kind: "human", seq: 2, author: { userId: "grace" } },
      { kind: "agent", seq: 3 },
    ];
    expect(latestAuthor(rows)).toBe("grace");
    // An answer to the agent's questions counts as its writer's words, where it was given.
    const answered = {
      kind: "tool",
      seq: 4,
      answers: { "Which?": "A" },
      decision: { by: { userId: "ada" }, seq: 6 },
    };
    expect(latestAuthor([...rows, answered])).toBe("ada");
    expect(latestAuthor([...rows, answered, { ...rows[1]!, seq: 7 }])).toBe("grace");
    expect(latestAuthor([...rows, { ...answered, answers: undefined }])).toBe("grace");
    const review = [rule({ approvers: [EDITORS], independent: true })];
    expect(mayApprove(grace, review, "review", "grace")).toBe(false);
    expect(mayApprove(ada, review, "review", "grace")).toBe(true);
    // Independence applies to approvals, whoever wrote last, only where review applies.
    expect(mayApprove(grace, [OPEN], "ask", "grace")).toBe(true);
  });

  it("raises the tool's risk where a policy lets no one use it or asks for independence", () => {
    expect(riskOf("normal", [OPEN])).toBe("normal");
    expect(riskOf("ask", [OPEN])).toBe("ask");
    expect(riskOf("review", [rule({ approvers: [EDITORS] })])).toBe("review");
    expect(riskOf("normal", [OPEN, rule({ approvers: [EDITORS] })])).toBe("ask");
    expect(riskOf("normal", [engineering])).toBe("normal");
    expect(riskOf("normal", [{ ...engineering, independent: true }])).toBe("review");
    expect(riskOf("normal", [{ ...OPEN, independent: true }])).toBe("normal");
  });
});

describe("deciding a call", () => {
  const can = (seq: number, userId = "ada"): Influence => ({
    seq,
    userId,
    canPost: true,
    canUse: true,
  });
  const cannot = (seq: number, userId = "alan"): Influence => ({
    seq,
    userId,
    canPost: true,
    canUse: false,
  });
  const cases: [string, Parameters<typeof decide>[0], Decision["kind"]][] = [
    [
      "owner alone, normal risk",
      { declared: "normal", rules: [OPEN], influence: [can(1)], standing: [] },
      "run",
    ],
    [
      "someone who can't use it wrote earlier",
      { declared: "normal", rules: [OPEN], influence: [can(1), cannot(2)], standing: [] },
      "wait",
    ],
    [
      "a standing approval after they wrote",
      {
        declared: "normal",
        rules: [OPEN],
        influence: [cannot(2)],
        standing: [{ atSeq: 5, by: "grace", eligible: true }],
      },
      "standing",
    ],
    [
      "they wrote after the standing approval",
      {
        declared: "normal",
        rules: [OPEN],
        influence: [cannot(6)],
        standing: [{ atSeq: 5, by: "grace", eligible: true }],
      },
      "wait",
    ],
    [
      "the approval's giver may no longer approve",
      {
        declared: "normal",
        rules: [OPEN],
        influence: [cannot(2)],
        standing: [{ atSeq: 5, by: "grace", eligible: false }],
      },
      "wait",
    ],
    [
      "the tool declares it asks",
      {
        declared: "ask",
        rules: [OPEN],
        influence: [can(1)],
        standing: [{ atSeq: 5, by: "grace", eligible: true }],
      },
      "wait",
    ],
    [
      "a policy that lets no one use it",
      {
        declared: "normal",
        rules: [OPEN, rule({ approvers: [EDITORS] })],
        influence: [can(1)],
        standing: [{ atSeq: 5, by: "grace", eligible: true }],
      },
      "wait",
    ],
    [
      "independent approval ignores standing approvals",
      {
        declared: "normal",
        rules: [rule({ use: "some", approvers: [EDITORS], independent: true })],
        influence: [cannot(1)],
        standing: [{ atSeq: 5, by: "grace", eligible: true }],
      },
      "wait",
    ],
    [
      "independent approval holds back even its users",
      {
        declared: "normal",
        rules: [
          rule({ use: "some", users: ["user:ada"], approvers: [EDITORS], independent: true }),
        ],
        influence: [can(1)],
        standing: [],
      },
      "wait",
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(decide(input).kind).toBe(expected);
  });
});

describe("deciding a call that runs with a person's own login", () => {
  const can = (seq: number, userId: string): Influence => ({
    seq,
    userId,
    canPost: true,
    canUse: true,
  });
  const connected = (...ids: string[]) => {
    const set = new Set(ids);
    return (userId: string) => set.has(userId);
  };
  const base = { declared: "normal" as const, rules: [OPEN], standing: [] };

  it("runs at once as a solo writer who may use it and is connected", () => {
    expect(
      decide({ ...base, influence: [can(1, "ada"), can(3, "ada")], connected: connected("ada") }),
    ).toEqual({ kind: "run", runAs: "ada" });
  });

  it("waits in a group chat, or for a solo writer with no working connection", () => {
    const group = [can(1, "ada"), can(2, "grace")];
    expect(decide({ ...base, influence: group, connected: connected("ada", "grace") })).toEqual({
      kind: "wait",
    });
    expect(decide({ ...base, influence: [can(1, "ada")], connected: connected() })).toEqual({
      kind: "wait",
    });
    // Nobody's words: nobody to run as.
    expect(decide({ ...base, influence: [], connected: connected("ada") })).toEqual({
      kind: "wait",
    });
  });

  it("runs on an approval for now as its giver, until someone else writes or their connection breaks", () => {
    const standing = [{ atSeq: 5, eligible: true, callId: "call-1", by: "grace" }];
    const before = [can(1, "ada"), can(2, "grace")];
    expect(decide({ ...base, influence: before, standing, connected: connected("grace") })).toEqual(
      { kind: "standing", callId: "call-1", runAs: "grace" },
    );
    // The giver writing again keeps it.
    expect(
      decide({
        ...base,
        influence: [...before, can(7, "grace")],
        standing,
        connected: connected("grace"),
      }),
    ).toMatchObject({ kind: "standing", runAs: "grace" });
    // Anyone else's new words end it, even someone who may use the tool directly.
    expect(
      decide({
        ...base,
        influence: [...before, can(7, "ada")],
        standing,
        connected: connected("grace", "ada"),
      }),
    ).toEqual({ kind: "wait" });
    // So does the giver's connection breaking, or their losing the right to approve.
    expect(decide({ ...base, influence: before, standing, connected: connected() })).toEqual({
      kind: "wait",
    });
    expect(
      decide({
        ...base,
        influence: before,
        standing: [{ ...standing[0]!, eligible: false }],
        connected: connected("grace"),
      }),
    ).toEqual({ kind: "wait" });
  });

  it("never runs for now where every call asks", () => {
    const standing = [{ atSeq: 5, eligible: true, callId: "call-1", by: "grace" }];
    for (const input of [
      { ...base, declared: "ask" as const },
      { ...base, rules: [OPEN, rule({ approvers: [EDITORS] })] },
    ]) {
      expect(
        decide({ ...input, influence: [can(1, "grace")], standing, connected: connected("grace") }),
      ).toEqual({ kind: "wait" });
    }
  });
});

// The agent thread with a guest, Hedy, let into it, and subagents for tool calls.
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
  // A policy of the org, or of the space when given; by default every call needs approval from
  // anyone who can edit the thread.
  function policy(fields: Partial<ToolPolicyFields> = {}, spaceId: string | null = null) {
    return workspace.toolPolicyStore.create({
      orgId: ada.orgId,
      spaceId,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
      ...fields,
    });
  }
  return {
    ...workspace,
    toolRegistry: workspace.tools,
    hedy,
    calls,
    tools,
    decideCall,
    setRole,
    revokeHedy,
    policy,
  };
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
      "thread.set_model",
      "thread.compact",
      "thread.ask",
      ...SUBAGENT_TOOLS,
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

  it("fail at once with input the tool does not take", async () => {
    const { ada, post, calls, model, worker, start, tools } = await toolThread();
    start();

    await post(ada, "Rename it");
    await calls(["thread.rename", { name: "x" }]);
    const next = await answered(model.next());
    await worker.idle();

    expect(tools().map((row) => row.state)).toEqual(["failed"]);
    expect(next.texts.at(-1)).toContain("The input is not valid");
  });

  it("wait for a decision when someone who can no longer message wrote, letting the lease go", async () => {
    const workspace = await toolThread();
    const { ada, hedy, grace, post, calls, model, runStore, thread, makeWorker, start } = workspace;
    const first = makeWorker();
    start(first);
    await post(hedy, "Please rename this to Research");
    workspace.revokeHedy();
    await calls(["thread.rename", { title: "Research" }]);
    await first.idle();

    const waiting = runStore.active(thread.id);
    expect(waiting).toMatchObject({ status: "waiting", leaseOwner: null });
    expect(workspace.transcript().at(-1)).toBe("thread.rename (pending)");
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
      "thread.rename (ran by Grace Hopper)",
      "Agent (completed): Done.",
    ]);
    expect(next.texts.at(-1)).toBe(
      'result thread.rename: {"ok":true,"value":{"title":"Research"}}',
    );
    expect(workspace.threadStore.find(thread.id)?.title).toBe("Research");
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

  it("ask every time where no one may use the tool directly, never for now", async () => {
    const { ada, post, calls, model, worker, start, tools, decideCall, toolSettings, policy } =
      await toolThread();
    toolSettings.setInOrg(ada.orgId, ["thread.rename"], policy().id);
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

  it("are not offered where the org or the space turned them off, but fixed ones always are", async () => {
    const workspace = await toolThread();
    const { ada, post, model, worker, start, toolSettings, space } = workspace;
    toolSettings.setInOrg(ada.orgId, ["thread.rename", "thread.info"], TOOL_OFF);
    toolSettings.setInSpace(space.id, ["thread.set_model", "thread.ask"], TOOL_OFF);
    start();
    await post(ada, "Hello");
    const call = await answered(model.next());
    await worker.idle();
    expect(call.tools).toEqual(["thread.compact", "thread.ask", ...SUBAGENT_TOOLS]);

    const other = await workspace.createSpace(ada.cookie, "Other");
    const thread = await workspace.createThread(ada.cookie, other.id, "Hello there");
    const elsewhere = await answered(model.next());
    await worker.idle();
    expect(thread.id).toBeDefined();
    expect(elsewhere.tools).toEqual([
      "thread.set_model",
      "thread.compact",
      "thread.ask",
      ...SUBAGENT_TOOLS,
    ]);
  });
});

describe("tool policies", () => {
  it("let the people a policy names use a tool directly, and only its approvers approve the rest", async () => {
    const {
      ada,
      grace,
      alan,
      post,
      calls,
      model,
      worker,
      start,
      tools,
      decideCall,
      toolSettings,
      policy,
    } = await toolThread();
    const team = policy({
      use: "some",
      users: [`user:${grace.userId}`],
      approvers: [`user:${ada.userId}`, `user:${alan.userId}`],
    });
    toolSettings.setInOrg(ada.orgId, ["thread.rename"], team.id);
    start();

    await post(grace, "Rename it to Looms");
    await calls(["thread.rename", { title: "Looms" }]);
    await answered(model.next());
    await worker.idle();
    expect(tools()[0]).toMatchObject({ state: "ran", waits: false });

    await post(ada, "Rename it to Engines");
    await calls(["thread.rename", { title: "Engines" }]);
    await worker.idle();
    const pending = tools()[1]!;
    expect(pending).toMatchObject({ state: "pending", waits: true, risk: "normal" });
    // Grace may use it but does not approve it; Alan is named but only views the thread.
    expect((await decideCall(grace, pending.id, true)).status).toBe(403);
    expect((await decideCall(alan, pending.id, true)).status).toBe(403);
    expect((await decideCall(ada, pending.id, true)).status).toBe(200);
    await answered(model.next());
    await worker.idle();
    expect(tools()[1]).toMatchObject({ state: "ran", decision: { by: { userId: ada.userId } } });
  });

  it("layer a space's extra rule on the org's: both must let someone use it or approve it", async () => {
    const {
      ada,
      grace,
      space,
      post,
      calls,
      worker,
      start,
      tools,
      decideCall,
      toolSettings,
      policy,
    } = await toolThread();
    const org = policy({
      use: "some",
      users: [`user:${ada.userId}`, `user:${grace.userId}`],
      approvers: [`user:${grace.userId}`],
    });
    const extra = policy(
      {
        use: "some",
        users: [`user:${grace.userId}`],
        approvers: [`user:${ada.userId}`, `user:${grace.userId}`],
      },
      space.id,
    );
    toolSettings.setInOrg(ada.orgId, ["thread.rename"], org.id);
    toolSettings.setInSpace(space.id, ["thread.rename"], extra.id);
    start();

    // The org lets Ada use it directly, but the space does not.
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();
    const pending = tools()[0]!;
    expect(pending).toMatchObject({ state: "pending", waits: true });
    // The space names Ada as an approver, but the org does not.
    expect((await decideCall(ada, pending.id, true)).status).toBe(403);
    expect((await decideCall(grace, pending.id, true)).status).toBe(200);
  });

  it("leave a call waiting with nobody to approve it when its policy is not the space's", async () => {
    const workspace = await toolThread();
    const {
      ada,
      grace,
      space,
      post,
      calls,
      worker,
      start,
      tools,
      decideCall,
      toolSettings,
      policy,
    } = workspace;
    const other = await workspace.createSpace(ada.cookie, "Other");
    toolSettings.setInSpace(space.id, ["thread.rename"], policy({ use: "everyone" }, other.id).id);
    start();
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();
    expect(tools()[0]).toMatchObject({ state: "pending", waits: true });
    expect((await decideCall(ada, tools()[0]!.id, true)).status).toBe(403);
    expect((await decideCall(grace, tools()[0]!.id, true)).status).toBe(403);
  });
});

describe("independent review", () => {
  it.each([
    ["open", null],
    ["sign-off", "sign-off"],
  ] as const)(
    "lets the requester decide the pending call after changing review to %s",
    async (_name, next) => {
      const {
        ada,
        space,
        thread,
        post,
        calls,
        model,
        worker,
        start,
        tools,
        decideCall,
        toolSettings,
        api,
        policy,
      } = await toolThread();
      const review = policy({ name: "Independent review", independent: true });
      const signOff = policy();
      toolSettings.setInSpace(space.id, ["thread.rename"], review.id);
      start();
      await post(ada, "Rename it");
      await calls(["thread.rename", { title: "Engines" }]);
      await worker.idle();
      const callId = tools()[0]!.id;
      expect((await decideCall(ada, callId, true)).status).toBe(403);
      const changed = await api("PATCH", `/spaces/${space.id}/tools`, ada.cookie, {
        toolIds: ["thread.rename"],
        policy: next && signOff.id,
      });
      expect(changed.status).toBe(200);
      const detail = await api("GET", `/threads/${thread.id}`, ada.cookie);
      const { rows } = (await detail.json()) as { rows: { id: string }[] };
      expect(rows.find((row) => row.id === callId)).toMatchObject({
        risk: next ? "ask" : "normal",
        actions: next ? ["allow", "deny"] : ["allow", "allow_for_now", "deny"],
      });
      const listed = await api("GET", `/spaces/${space.id}/threads`, ada.cookie);
      expect(await listed.json()).toContainEqual(
        expect.objectContaining({
          id: thread.id,
          activity: expect.objectContaining({ canApprove: true }),
        }),
      );
      // The audit log still records the requirement at request time.
      expect(tools()[0]?.risk).toBe("review");
      expect((await decideCall(ada, callId, true)).status).toBe(200);
      await answered(model.next());
      await worker.idle();
      expect(tools()[0]?.state).toBe("ran");
    },
  );

  it("does not downgrade a tool's declared review risk under a sign-off policy", async () => {
    const { ada, space, toolRegistry, toolSettings, policy } = await toolThread();
    const spec = toolRegistry.find(ada.orgId, "thread.rename")!;
    spec.risk = () => "review";
    toolSettings.setInSpace(space.id, [spec.name], policy().id);
    expect(
      toolRegistry.riskOf({ ...space, orgId: ada.orgId }, spec, { title: "Looms" }, null),
    ).toBe("review");
  });

  it("waits for an approver who did not write last, and never grants standing review", async () => {
    const {
      ada,
      grace,
      alan,
      hedy,
      space,
      thread,
      post,
      calls,
      model,
      start,
      worker,
      tools,
      decideCall,
      toolSettings,
      api,
      policy,
    } = await toolThread();
    toolSettings.setInOrg(ada.orgId, ["thread.rename"], policy({ independent: true }).id);
    // A space's extra rule cannot loosen the organization's independent review.
    toolSettings.setInSpace(space.id, ["thread.rename"], policy({}, space.id).id);
    start();
    await post(ada, "Rename it");
    await post(hedy, "// I suggested the name");
    await calls(["thread.rename", { title: "Engines" }]);
    await worker.idle();
    const pending = tools()[0]!;
    expect(pending).toMatchObject({ risk: "review", state: "pending" });
    const loosened = await api("PATCH", `/spaces/${space.id}/tools`, ada.cookie, {
      toolIds: ["thread.rename"],
      policy: null,
    });
    expect(loosened.status).toBe(200);
    expect((await decideCall(hedy, pending.id, true)).status).toBe(403);
    expect((await decideCall(alan, pending.id, true)).status).toBe(403);
    expect((await decideCall(grace, pending.id, true, "for_now")).status).toBe(400);
    for (const [who, canApprove] of [
      [hedy, false],
      [grace, true],
    ] as const) {
      const list = await api(
        "GET",
        who === hedy ? "/shared-threads" : `/spaces/${space.id}/threads`,
        who.cookie,
      );
      expect(await list.json()).toContainEqual(
        expect.objectContaining({
          id: thread.id,
          activity: expect.objectContaining({ canApprove }),
        }),
      );
    }
    expect((await decideCall(grace, pending.id, true)).status).toBe(200);
    await answered(model.next());
    await worker.idle();
    expect(tools()[0]).toMatchObject({ state: "ran", decision: { by: { userId: grace.userId } } });
    await post(ada, "Rename it again");
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();
    expect(tools()[1]).toMatchObject({ risk: "review", state: "pending" });
    expect((await decideCall(ada, tools()[1]!.id, true)).status).toBe(403);
  });

  it("rechecks independence before executing an approved call", async () => {
    const {
      ada,
      grace,
      space,
      post,
      calls,
      model,
      start,
      makeWorker,
      tools,
      decideCall,
      toolSettings,
      threadStore,
      thread,
      policy,
    } = await toolThread();
    toolSettings.setInSpace(space.id, ["thread.rename"], policy({ independent: true }).id);
    const first = makeWorker();
    start(first);
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Engines" }]);
    await first.idle();
    await first.stop();
    expect((await decideCall(grace, tools()[0]!.id, true)).status).toBe(200);
    await post(grace, "// I now want a different name");
    const second = makeWorker();
    start(second);
    await answered(model.next());
    await second.idle();
    expect(tools()[0]?.state).toBe("stale");
    expect(threadStore.find(thread.id)?.title).not.toBe("Engines");
  });

  it("does not let an earlier normal approval bypass a new review requirement", async () => {
    const workspace = await toolThread();
    const {
      ada,
      hedy,
      grace,
      space,
      post,
      calls,
      model,
      start,
      makeWorker,
      tools,
      decideCall,
      toolSettings,
      policy,
    } = workspace;
    const first = makeWorker();
    start(first);
    await post(hedy, "Rename it");
    workspace.revokeHedy();
    await calls(["thread.rename", { title: "Engines" }]);
    await first.idle();
    await first.stop();
    expect((await decideCall(ada, tools()[0]!.id, true, "for_now")).status).toBe(200);
    toolSettings.setInSpace(space.id, ["thread.rename"], policy({ independent: true }).id);
    const second = makeWorker();
    start(second);
    await answered(model.next());
    await second.idle();
    expect(tools()[0]?.state).toBe("stale");
    // Someone who did not write last can decide future review calls, but standing grants cannot.
    await post(ada, "Again");
    await calls(["thread.rename", { title: "Looms" }]);
    await second.idle();
    expect(tools()[1]?.state).toBe("pending");
    expect((await decideCall(grace, tools()[1]!.id, false)).status).toBe(200);
    await answered(model.next());
    await second.idle();
  });
});

describe("built-in toolset switches", () => {
  it.each(["org", "space"] as const)(
    "prevents a pending built-in call from executing after its %s toolset switch is off",
    async (scope) => {
      const {
        ada,
        space,
        post,
        calls,
        model,
        start,
        makeWorker,
        tools,
        decideCall,
        toolSettings,
        threadStore,
        thread,
        api,
        policy,
      } = await toolThread();
      toolSettings.setInSpace(space.id, ["thread.rename"], policy().id);
      const first = makeWorker();
      start(first);
      await post(ada, "Rename it");
      await calls(["thread.rename", { title: "Engines" }]);
      await first.idle();
      await first.stop();
      const path = scope === "org" ? "/org/toolsets/thread" : `/spaces/${space.id}/toolsets/thread`;
      expect((await api("PUT", path, ada.cookie, { enabled: false })).status).toBe(200);
      expect((await decideCall(ada, tools()[0]!.id, true)).status).toBe(200);
      const second = makeWorker();
      start(second);
      await answered(model.next());
      await second.idle();
      expect(tools()[0]?.state).toBe("stale");
      expect(threadStore.find(thread.id)?.title).not.toBe("Engines");
    },
  );
  it("preserves tool policies, isolates space switches, and prevents overriding an org switch", async () => {
    const { ada, grace, alan, api, space, createSpace, toolSettings, toolRegistry, policy } =
      await toolThread();
    const elsewhere = await createSpace(ada.cookie, "Elsewhere");
    const signOff = policy();
    const review = policy({ independent: true });
    toolSettings.setInOrg(ada.orgId, ["thread.rename"], signOff.id);
    const setOrg = (enabled: boolean, cookie = ada.cookie) =>
      api("PUT", "/org/toolsets/thread", cookie, { enabled });
    const setSpace = (enabled: boolean, cookie = ada.cookie) =>
      api("PUT", `/spaces/${space.id}/toolsets/thread`, cookie, { enabled });
    expect((await setOrg(false, grace.cookie)).status).toBe(403);
    expect((await setSpace(false, alan.cookie)).status).toBe(403);
    expect((await setSpace(false)).status).toBe(200);
    const off = await api("GET", `/spaces/${space.id}/tools`, ada.cookie);
    expect(await off.json()).toContainEqual(
      expect.objectContaining({
        id: "thread",
        enabled: false,
        orgEnabled: true,
        tools: expect.arrayContaining([
          expect.objectContaining({ id: "thread.rename", orgPolicy: signOff.id, policy: null }),
        ]),
      }),
    );
    // What is always on stays.
    const fixed = ["thread.ask"];
    const offered = (spaceId: string) =>
      toolRegistry
        .offered({ id: spaceId, orgId: ada.orgId })
        .map((spec) => spec.name)
        .filter((id) => id.startsWith("thread."));
    expect(offered(space.id)).toEqual(fixed);
    expect(offered(elsewhere.id).length).toBeGreaterThan(fixed.length);
    expect((await setOrg(false)).status).toBe(200);
    expect((await setSpace(true)).status).toBe(409);
    expect(
      toolRegistry.definitions({ id: elsewhere.id, orgId: ada.orgId }).map((tool) => tool.name),
    ).toEqual([...fixed, ...SUBAGENT_TOOLS]);
    const changeWhileOff = await api("PATCH", `/spaces/${space.id}/tools`, ada.cookie, {
      toolIds: ["thread.rename"],
      policy: review.id,
    });
    expect(changeWhileOff.status).toBe(200);
    expect((await setOrg(true)).status).toBe(200);
    expect(offered(space.id)).toEqual(fixed);
    expect((await setSpace(true)).status).toBe(200);
    const restored = await api("GET", `/spaces/${space.id}/tools`, ada.cookie);
    expect(await restored.json()).toContainEqual(
      expect.objectContaining({
        id: "thread",
        enabled: true,
        tools: expect.arrayContaining([
          expect.objectContaining({
            id: "thread.rename",
            orgPolicy: signOff.id,
            policy: review.id,
          }),
        ]),
      }),
    );
  });
});

const signOffInput = {
  name: "Sign-off",
  color: "orange",
  use: "none",
  users: [],
  approvers: [EDITORS],
  independent: false,
};

describe("tool settings", () => {
  it("let org owners set each tool to an org policy or off, and spaces add rules or turn tools off", async () => {
    const { ada, grace, api, space, createSpace } = await toolThread();
    const change = (toolIds: string[], policy: string | null) => ({ toolIds, policy });
    const made = await api("POST", "/org/tool-policies", ada.cookie, signOffInput);
    expect(made.status).toBe(201);
    const signOff = (await made.json()) as { id: string };

    expect(
      (await api("PATCH", "/org/tools", grace.cookie, change(["thread.compact"], signOff.id)))
        .status,
    ).toBe(403);
    expect(
      (await api("PATCH", "/org/tools", ada.cookie, change(["thread.nope"], signOff.id))).status,
    ).toBe(404);
    expect(
      (await api("PATCH", "/org/tools", ada.cookie, change(["thread.compact"], "nope"))).status,
    ).toBe(404);
    const org = await api(
      "PATCH",
      "/org/tools",
      ada.cookie,
      change(["thread.compact"], signOff.id),
    );
    const thread = (
      (await org.json()) as { id: string; title: string; source: string; tools: unknown[] }[]
    ).find((toolset) => toolset.id === "thread");
    expect(thread).toMatchObject({ id: "thread", title: "Thread", source: "builtin" });
    expect(thread!.tools).toContainEqual(
      expect.objectContaining({ id: "thread.compact", orgPolicy: signOff.id, policy: signOff.id }),
    );
    expect(thread!.tools).toContainEqual(
      expect.objectContaining({
        id: "thread.rename",
        orgPolicy: null,
        definition: expect.objectContaining({ annotations: { readOnlyHint: false } }),
      }),
    );
    // What is always on shows, but takes no policy.
    expect(thread!.tools).toContainEqual(
      expect.objectContaining({ id: "thread.ask", fixed: true, policy: null }),
    );
    expect(thread!.tools).toContainEqual(
      expect.objectContaining({ id: "thread.info", orgPolicy: null, policy: null }),
    );
    expect(thread!.tools.filter((tool) => (tool as { fixed?: boolean }).fixed)).toHaveLength(1);
    expect(
      (await api("PATCH", "/org/tools", ada.cookie, change(["thread.ask"], TOOL_OFF))).status,
    ).toBe(404);

    // A space's own policy is for its tools alone, never the org's or another space's.
    const own = await api("POST", `/spaces/${space.id}/tool-policies`, ada.cookie, {
      ...signOffInput,
      name: "Space sign-off",
    });
    expect(own.status).toBe(201);
    const spacePolicy = (await own.json()) as { id: string; spaceId: string };
    expect(spacePolicy.spaceId).toBe(space.id);
    expect(
      (await api("PATCH", "/org/tools", ada.cookie, change(["thread.compact"], spacePolicy.id)))
        .status,
    ).toBe(404);
    const other = await createSpace(ada.cookie, "Other");
    expect(
      (
        await api(
          "PATCH",
          `/spaces/${other.id}/tools`,
          ada.cookie,
          change(["thread.compact"], spacePolicy.id),
        )
      ).status,
    ).toBe(404);

    const changed = await api(
      "PATCH",
      `/spaces/${space.id}/tools`,
      ada.cookie,
      change(["thread.rename"], TOOL_OFF),
    );
    await api(
      "PATCH",
      `/spaces/${space.id}/tools`,
      ada.cookie,
      change(["thread.set_model"], spacePolicy.id),
    );
    expect(changed.status).toBe(200);
    const listed = await api("GET", `/spaces/${space.id}/tools`, ada.cookie);
    const inSpace = ((await listed.json()) as { id: string; tools: unknown[] }[]).find(
      (toolset) => toolset.id === "thread",
    )!;
    expect(inSpace!.tools).toEqual([
      expect.objectContaining({ id: "thread.info", orgPolicy: null, policy: null }),
      expect.objectContaining({ id: "thread.rename", orgPolicy: null, policy: TOOL_OFF }),
      expect.objectContaining({ id: "thread.set_model", orgPolicy: null, policy: spacePolicy.id }),
      expect.objectContaining({ id: "thread.compact", orgPolicy: signOff.id, policy: null }),
      expect.objectContaining({ id: "thread.ask", orgPolicy: null, policy: null, fixed: true }),
    ]);
    expect((await api("GET", `/spaces/${space.id}/tools`, grace.cookie)).status).toBe(403);
  });

  it("make, change and delete policies: the org's by its owners, a space's by its managers", async () => {
    const { ada, grace, alan, api, space } = await toolThread();
    expect((await api("POST", "/org/tool-policies", grace.cookie, signOffInput)).status).toBe(403);
    expect(
      (await api("POST", `/spaces/${space.id}/tool-policies`, grace.cookie, signOffInput)).status,
    ).toBe(403);
    // Someone must approve when not everyone can use it.
    const noApprover = await api("POST", "/org/tool-policies", ada.cookie, {
      ...signOffInput,
      approvers: [],
    });
    expect(noApprover.status).toBe(400);
    expect(await noApprover.json()).toEqual({ error: "Pick at least one approver" });
    expect(
      (
        await api("POST", "/org/tool-policies", ada.cookie, {
          ...signOffInput,
          approvers: ["user:nobody"],
        })
      ).status,
    ).toBe(400);

    const made = await api("POST", "/org/tool-policies", ada.cookie, {
      ...signOffInput,
      use: "some",
      users: [`user:${grace.userId}`],
      approvers: [EDITORS, `user:${alan.userId}`],
    });
    const policy = (await made.json()) as { id: string };
    expect(policy).toMatchObject({
      spaceId: null,
      use: "some",
      users: [{ key: `user:${grace.userId}`, kind: "user", name: "Grace Hopper", stale: false }],
      approvers: [
        { key: EDITORS, kind: "editors", name: "Anyone who can edit the thread" },
        { key: `user:${alan.userId}`, name: "Alan Turing" },
      ],
      toolCount: 0,
    });
    const everyone = await api("PUT", `/org/tool-policies/${policy.id}`, ada.cookie, {
      ...signOffInput,
      name: "Open to all",
      use: "everyone",
      users: [`user:${grace.userId}`],
      independent: true,
    });
    // Everyone uses it, so nobody approves and nothing is independent.
    expect(await everyone.json()).toMatchObject({
      name: "Open to all",
      use: "everyone",
      users: [],
      approvers: [],
      independent: false,
    });

    await api("PATCH", "/org/tools", ada.cookie, {
      toolIds: ["thread.compact"],
      policy: policy.id,
    });
    const listed = (await (await api("GET", "/org/tool-policies", grace.cookie)).json()) as {
      id: string;
      toolCount: number;
    }[];
    expect(listed).toEqual([expect.objectContaining({ id: policy.id, toolCount: 1 })]);
    expect((await api("DELETE", `/org/tool-policies/${policy.id}`, ada.cookie)).status).toBe(409);
    // A space can use the org's policies, but not change them.
    const inSpace = (await (
      await api("GET", `/spaces/${space.id}/tool-policies`, ada.cookie)
    ).json()) as { id: string }[];
    expect(inSpace.map((found) => found.id)).toEqual([policy.id]);
    expect(
      (await api("DELETE", `/spaces/${space.id}/tool-policies/${policy.id}`, ada.cookie)).status,
    ).toBe(404);
    await api("PATCH", "/org/tools", ada.cookie, { toolIds: ["thread.compact"], policy: null });
    expect((await api("DELETE", `/org/tool-policies/${policy.id}`, ada.cookie)).status).toBe(200);
    expect(await (await api("GET", "/org/tool-policies", ada.cookie)).json()).toEqual([]);
  });
});

describe("thread lists", () => {
  it("say when the agent waits for a decision, on which tool, and who may make it", async () => {
    const {
      ada,
      alan,
      hedy,
      post,
      calls,
      worker,
      start,
      api,
      space,
      thread,
      toolSettings,
      policy,
    } = await toolThread();
    toolSettings.setInSpace(space.id, ["thread.rename"], policy().id);
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
    const {
      ada,
      alan,
      hedy,
      post,
      calls,
      worker,
      start,
      api,
      space,
      thread,
      toolSettings,
      policy,
    } = await toolThread();
    toolSettings.setInSpace(space.id, ["thread.rename"], policy().id);
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

describe("Mage's own toolsets", () => {
  const unused = {} as Omit<Parameters<typeof createTools>[0], "toolsets">;
  const toolset = (id: string, names: string[]): Toolset => ({
    id,
    title: id,
    source: "builtin",
    tools: names.map((name) => ({
      name,
      description: name,
      input: z.object({}),
      risk: () => "normal",
      run: () => Promise.resolve({ ok: true, value: null }),
    })),
  });

  it("each keep a name of their own, which their tools' names start with", () => {
    expect(() =>
      createTools({ ...unused, toolsets: [toolset("resource", ["resource.list"])] }),
    ).not.toThrow();
    expect(() =>
      createTools({
        ...unused,
        toolsets: [toolset("resource", ["resource.list"]), toolset("resource", [])],
      }),
    ).toThrow("Two of Mage's own toolsets are named resource");
    expect(() =>
      createTools({ ...unused, toolsets: [toolset("files", ["resource.read"])] }),
    ).toThrow("resource.read is outside its toolset's names");
    expect(() => createTools({ ...unused, toolsets: [toolset("mcp", [])] })).toThrow();
  });

  it("leave mcp.* to MCP servers", () => {
    expect(() =>
      createTools({ ...unused, toolsets: [toolset("mcp_servers", ["mcp_servers.search_tools"])] }),
    ).not.toThrow();
    expect(() =>
      createTools({ ...unused, toolsets: [toolset("mcp.notes", ["mcp.notes.search"])] }),
    ).toThrow("mcp.notes is outside its toolset's names");
    expect(() =>
      createTools({ ...unused, toolsets: [toolset("mcp._", ["mcp._.search"])] }),
    ).toThrow();
  });

  it("keep their MCP tools' names on the wire, apart from every server's, and map them back", () => {
    const own = [
      "mcp_servers.search_tools",
      "mcp_servers.list_resources",
      "mcp_servers.read_resource",
    ];
    // Servers whose tools come closest: one with the short name `servers`, and tools named as
    // Mage's own.
    const servers = [
      "mcp.servers.search_tools",
      "mcp.servers.list_resources",
      "mcp.servers_.read_resource",
    ];
    const tools = [...own, ...servers, "thread.info"].map((id) => ({ id, name: id }));
    const names = modelToolNames(tools);
    for (const id of own) expect(names.get(id)).toBe(id);
    const wire = [...names.values()].map(wireToolName);
    expect(new Set(wire).size).toBe(tools.length);
    expect(wire.every((name) => name.length <= WIRE_NAME_MAX)).toBe(true);
    expect(own.map((id) => wireToolName(id))).toEqual([
      "mcp_servers__search_tools",
      "mcp_servers__list_resources",
      "mcp_servers__read_resource",
    ]);
    // Back from the wire to each id, as a run reads the model's calls.
    const fromWire = new Map([...names].map(([id, name]) => [wireToolName(name), id]));
    for (const { id } of tools) expect(fromWire.get(wireToolName(names.get(id)!))).toBe(id);
  });
});

describe("waiting calls as each reader sees them", () => {
  type Workspace = Awaited<ReturnType<typeof toolThread>>;

  // The thread's waiting call as the reader reads it.
  async function waitingFor({ threads, thread, ada }: Workspace, who: { userId: string }) {
    const reader = { userId: who.userId, orgId: ada.orgId, role: "member" as const };
    const { rows } = await threads.get(reader, thread.id);
    return rows.find((row) => row.kind === "tool" && row.state === "pending");
  }

  it("offer Allow for now where a call may be, and leave it paused for those who may not decide", async () => {
    const workspace = await toolThread();
    const { ada, alan, hedy, post, calls, worker, start } = workspace;
    start();
    await post(hedy, "Rename it");
    workspace.revokeHedy();
    await calls(["thread.rename", { title: "Looms" }]);
    await worker.idle();

    expect(await waitingFor(workspace, ada)).toMatchObject({
      risk: "normal",
      actions: ["allow", "allow_for_now", "deny"],
    });
    expect(await waitingFor(workspace, alan)).toMatchObject({ actions: [] });
  });

  it("offer a call that asks every time only once", async () => {
    const workspace = await toolThread();
    const { ada, post, calls, worker, start } = workspace;
    start();
    await post(ada, "Switch providers");
    await calls(["thread.set_model", { model: "key-2/other", effort: "low" }]);
    await worker.idle();

    expect(await waitingFor(workspace, ada)).toMatchObject({
      risk: "ask",
      actions: ["allow", "deny"],
    });
  });

  it("leave a call needing review paused for whoever wrote last, and tell a follower when that changes", async () => {
    const workspace = await toolThread();
    const { ada, grace, space, post, calls, worker, start, threads, thread } = workspace;
    workspace.toolSettings.setInSpace(
      space.id,
      ["thread.rename"],
      workspace.policy({ independent: true }).id,
    );
    start();
    await post(ada, "Rename it");
    await calls(["thread.rename", { title: "Engines" }]);
    await worker.idle();
    const asAda = { userId: ada.userId, orgId: ada.orgId, role: "member" as const };
    const sent: ThreadFollowItem[] = [];
    const newest = threads.visible(asAda, thread.id).lastEventSeq;
    const stop = threads.follow(asAda, thread.id, newest, (item) => sent.push(item));

    expect(await waitingFor(workspace, ada)).toMatchObject({ risk: "review", actions: [] });
    expect(await waitingFor(workspace, grace)).toMatchObject({ actions: ["allow", "deny"] });

    // Grace writes last now, so Ada may review the call, though the call itself did not change.
    const asGrace = { userId: grace.userId, orgId: ada.orgId, role: "member" as const };
    threads.postMessage(asGrace, thread.id, "// Go ahead");
    stop();
    const last = sent.at(-1);
    expect(last?.kind === "rows" && last.update.rows).toEqual([
      expect.objectContaining({ kind: "tool", actions: ["allow", "deny"] }),
      expect.objectContaining({ kind: "human", text: "// Go ahead" }),
    ]);
    expect(await waitingFor(workspace, grace)).toMatchObject({ actions: [] });
  });
});
