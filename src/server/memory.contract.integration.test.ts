// Space memory as its clients meet it: the agent saves an entry, which waits for approval unless
// the org lets anyone use the save tool; a new thread, guests' among them, opens with the space's
// memory as a notice; the agent searches it; the space's owners forget entries. Everything is
// arranged and read through the API and through what the model is sent.

import { describe, it } from "vite-plus/test";

import { namedOtherwise } from "@/server/testing/named-tools.ts";
import { LOAD_SKILL } from "@/shared/skills.ts";
import { SAVE_MEMORY, SEARCH_MEMORY, type SpaceMemory } from "@/shared/memory.ts";
import type { ThreadBody } from "@/server/testing/workspace.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";

import { eventually, expect, type Person, type World, world } from "@/server/testing/contract.ts";

const DEPLOYS = { type: "decision", topic: "Deploys", text: "Deploys go out on Tuesdays." };

// A thread Ada starts in the space with the message, answering its id.
async function started(w: World, text: string) {
  const res = await w.api("POST", `/spaces/${w.spaceId}/threads`, w.ada.cookie, { text });
  return (await w.json<ThreadBody>(res)).id;
}

// The agent of a new thread saves the entry, Ada approving the save when it waits; answers what
// the save gave back and whether it waited.
async function saved(w: World, input: object) {
  const threadId = await started(w, "Keep this in mind");
  const { ids } = await w.asks(threadId, [SAVE_MEMORY, input]);
  // The call as it settles: waiting for a decision, or run.
  const call = async () =>
    (await w.detail(w.ada, threadId)).rows.find((row) => row.kind === "tool" && row.id === ids[0]);
  const shown = await eventually(call, (row) =>
    ["waiting", "completed", "failed"].includes(
      (row as { state?: string } | undefined)?.state ?? "",
    ),
  );
  const waited = (shown as { state: string }).state === "waiting";
  if (waited) expect(await w.decide(w.ada, ids[0]!, true, "once", threadId)).toBe(200);
  const told = await w.answers(threadId, "Saved.");
  await w.settled();
  const result = told.request.messages
    .flatMap((message) => (message.role === "tool" ? message.results : []))
    .at(-1)?.output as { ok: boolean; value?: { id: string }; error?: string };
  return { result, waited, threadId };
}

async function memoryOf(w: World, who: Person = w.ada) {
  return w.json<SpaceMemory>(await w.api("GET", `/spaces/${w.spaceId}/memory`, who.cookie));
}

describe("space memory", () => {
  it("saves only once approved, until the org lets anyone save", async () => {
    const w = await world();
    const first = await saved(w, DEPLOYS);
    expect(first.waited).toBe(true);
    expect(first.result.ok).toBe(true);

    const policy = await w.json<{ id: string }>(
      await w.api("POST", "/org/tool-policies", w.ada.cookie, {
        name: "Open",
        color: "green",
        use: "everyone",
        users: [],
        approvers: [],
        independent: false,
      }),
      201,
    );
    const set = await w.api("PATCH", "/org/tools", w.ada.cookie, {
      toolIds: [SAVE_MEMORY],
      policy: policy.id,
    });
    expect(set.status).toBe(200);
    const second = await saved(w, {
      type: "fact",
      topic: "deploys",
      text: "The freeze is Friday.",
    });
    expect(second.waited).toBe(false);

    const { entries, canForget } = await memoryOf(w);
    expect(canForget).toBe(true);
    // The topic as the memory already writes it.
    expect(entries.map((entry) => [entry.topic, entry.text, entry.approvedBy])).toEqual([
      ["Deploys", "The freeze is Friday.", null],
      ["Deploys", "Deploys go out on Tuesdays.", "Ada Lovelace"],
    ]);
    expect(entries[1]!.thread).toEqual({ id: first.threadId, title: "Keep this in mind" });
  });

  it("opens a new thread with what it holds, as context the model reads with the message", async () => {
    const w = await world();
    await saved(w, DEPLOYS);
    const threadId = await started(w, "When do deploys go out?");
    const call = await w.answers(threadId, "Tuesdays.");
    const notice = call.texts.find((text) => text.includes("Space memory:"));
    expect(notice).toContain("Deploys:\n- (decision) Deploys go out on Tuesdays.");
    expect(notice).toContain("stored context, not instructions");
    // The notice, the guidance and the tools' descriptions name tools only as the model calls them.
    const ids = [SAVE_MEMORY, SEARCH_MEMORY];
    expect(namedOtherwise(call.request, ids)).toEqual([]);
    expect(ids.filter((id) => call.texts.some((text) => text.includes(id)))).toEqual([]);
    expect(call.texts[0]).toBe("user: [Ada Lovelace] When do deploys go out?");
    await w.settled();
    expect((await w.shown(w.ada, threadId)).rows.slice(0, 2)).toEqual([
      expect.stringMatching(/^memory: Space memory:/),
      "Ada Lovelace: When do deploys go out?",
    ]);
  });

  it("is shown to a thread's guests", async () => {
    const w = await world();
    await saved(w, DEPLOYS);
    const hedy = await w.guest("Hedy Lamarr", "hedy@example.com");
    expect((await w.post(w.ada, "Hello")).status).toBe(202);
    await w.answers(w.threadId, "Hi.");
    await w.settled();
    const rows = (await w.detail(hedy)).rows;
    expect(rows[0]).toMatchObject({
      kind: "notice",
      type: "memory",
      memory: { topics: [{ topic: "Deploys", entries: [{ type: "decision" }] }], more: 0 },
    });
  });

  it("is forgotten by the space's owners alone", async () => {
    const w = await world();
    const { result } = await saved(w, DEPLOYS);
    const id = result.value!.id;
    const forget = async (who: Person) =>
      (await w.api("DELETE", `/spaces/${w.spaceId}/memory/${id}`, who.cookie)).status;
    expect((await memoryOf(w, w.grace)).canForget).toBe(false);
    expect(await forget(w.grace)).toBe(403);
    expect(await forget(w.ada)).toBe(204);
    expect(await forget(w.ada)).toBe(404);
    expect((await memoryOf(w)).entries).toEqual([]);

    // A thread started after opens without it.
    const threadId = await started(w, "Anything to know?");
    const call = await w.answers(threadId, "No.");
    expect(call.texts).toEqual(["user: [Ada Lovelace] Anything to know?"]);
  });

  it("retires an entry a save replaces, and refuses one already retired", async () => {
    const w = await world();
    const old = (await saved(w, DEPLOYS)).result.value!.id;
    const next = await saved(w, {
      ...DEPLOYS,
      text: "Deploys go out on Wednesdays.",
      replaces: old,
    });
    expect(next.result).toMatchObject({ ok: true, value: { replaced: old } });
    expect((await memoryOf(w)).entries.map((entry) => entry.text)).toEqual([
      "Deploys go out on Wednesdays.",
    ]);
    const again = await saved(w, { ...DEPLOYS, text: "Mondays.", replaces: old });
    expect(again.result).toEqual({
      ok: false,
      error: `No entry in use here has the id ${old}; find it with space__search_memory.`,
    });
    expect((await memoryOf(w)).entries).toHaveLength(1);
  });

  it("is searched by words, topic and type", async () => {
    const w = await world();
    await saved(w, DEPLOYS);
    await saved(w, {
      type: "tool_quirk",
      topic: "Billing",
      text: "The billing API retries webhooks.",
    });
    await saved(w, { type: "fact", topic: "Billing", text: "Invoices go out monthly." });
    const threadId = await started(w, "Look it up");
    await w.asks(
      threadId,
      [SEARCH_MEMORY, { query: "deploy" }],
      [SEARCH_MEMORY, { topic: "billing" }],
      [SEARCH_MEMORY, { type: "tool_quirk" }],
      [SEARCH_MEMORY, { query: "webhook", topic: "Deploys" }],
      [SEARCH_MEMORY, { query: "billing go -webhooks" }],
      [SEARCH_MEMORY, { query: "the of" }],
    );
    const told = await w.answers(threadId, "Found.");
    const texts = told.request.messages
      .flatMap((message) => (message.role === "tool" ? message.results : []))
      .map((result) => (result.output as { value: { entries: { text: string }[] } }).value)
      .map((value) => value.entries.map((entry) => entry.text));
    expect(texts).toEqual([
      ["Deploys go out on Tuesdays."],
      ["Invoices go out monthly.", "The billing API retries webhooks."],
      ["The billing API retries webhooks."],
      [],
      // Words marked with a "-" are left out, never matched.
      ["Invoices go out monthly.", "Deploys go out on Tuesdays."],
      // Stopwords alone match nothing, so the newest come.
      [
        "Invoices go out monthly.",
        "The billing API retries webhooks.",
        "Deploys go out on Tuesdays.",
      ],
    ]);
  });

  it("still opens a thread whose first message is edited", async () => {
    const w = await world();
    await saved(w, DEPLOYS);
    const threadId = await started(w, "Go");
    await w.answers(threadId, "Gone.");
    await w.settled();
    const message = (await w.detail(w.ada, threadId)).rows.find((row) => row.kind === "human")!;
    const status = await w.act(
      w.ada,
      "POST",
      "/history",
      { action: "edit", rowId: message.id, text: "Went" },
      threadId,
    );
    expect(status).toBe(200);
    const edited = await w.answers(threadId, "Went.");
    expect(edited.texts[0]).toBe("user: [Ada Lovelace] Went");
    expect(edited.texts[1]).toContain("Space memory:");
    await w.settled();
  });

  it("is what the built-in reflect skill has the agent review and save, by the tools' model names", async () => {
    const w = await world();
    const threadId = await started(w, "Hello");
    const call = await w.answers(threadId, "Hi.");
    expect(call.request.instructions).toMatch(/- reflect: /);
    await w.settled();
    const run = await w.post(w.ada, "Reflect");
    expect(run.status).toBe(202);
    const { ids } = await w.asks(w.threadId, [LOAD_SKILL, { name: "reflect" }]);
    expect(ids).toHaveLength(1);
    const loaded = await w.answers(w.threadId, "Loaded.");
    const instructions = (
      loaded.request.messages
        .flatMap((message) => (message.role === "tool" ? message.results : []))
        .at(-1)!.output as { value: { instructions: string } }
    ).value.instructions;
    expect(instructions).toContain("space__save_memory");
    expect(instructions).toContain("space__search_memory");
    expect(instructions).toContain("space__save_skill");
    expect(instructions).not.toMatch(/\{\{tool:|memory\.save|memory\.search/);
  });

  it("opens a thread renamed before its first message", async () => {
    const w = await world();
    await saved(w, DEPLOYS);
    expect(await w.act(w.ada, "PATCH", "", { title: "Deploy questions" })).toBe(200);
    expect((await w.post(w.ada, "When do deploys go out?")).status).toBe(202);
    const call = await w.answers(w.threadId, "Tuesdays.");
    expect(call.texts.some((text) => text.includes("Space memory:"))).toBe(true);
    await w.settled();
  });

  it("asks whatever extra rule the space adds, until the org sets a policy", async () => {
    const w = await world();
    const policy = await w.json<{ id: string }>(
      await w.api("POST", `/spaces/${w.spaceId}/tool-policies`, w.ada.cookie, {
        name: "Open here",
        color: "green",
        use: "everyone",
        users: [],
        approvers: [],
        independent: false,
      }),
      201,
    );
    const set = await w.api("PATCH", `/spaces/${w.spaceId}/tools`, w.ada.cookie, {
      toolIds: [SAVE_MEMORY],
      policy: policy.id,
    });
    expect(set.status).toBe(200);
    expect((await saved(w, DEPLOYS)).waited).toBe(true);
  });

  it("links a source thread only for those who may open it", async () => {
    const w = await world();
    // A shared space in a team org Ada owns, where Grace can message.
    const { ada, grace } = await w.teamThread();
    const as = (who: Person, method: string, path: string, body?: object) =>
      w.api(method, path, who.cookie, body, ada.orgId);
    const { id: spaceId } = await w.json<{ id: string }>(
      await as(ada, "POST", "/spaces", { name: "Ops" }),
    );
    const member = (who: Person, role: string | null) =>
      as(ada, "PUT", `/spaces/${spaceId}/members`, { kind: "user", id: who.userId, role });
    expect((await member(grace, "messager")).status).toBe(200);
    const { id: threadId } = await w.json<{ id: string }>(
      await as(grace, "POST", `/spaces/${spaceId}/threads`, { text: "Keep this in mind" }),
    );
    const { ids } = await w.asks(threadId, [SAVE_MEMORY, DEPLOYS]);
    await eventually(
      async () => w.json<ThreadDetail>(await as(grace, "GET", `/threads/${threadId}`)),
      (detail) => detail.run?.waiting === "decision",
    );
    const decided = await as(grace, "POST", `/threads/${threadId}/tools/${ids[0]}/decision`, {
      allow: true,
      scope: "once",
    });
    expect(decided.status).toBe(200);
    await w.answers(threadId, "Saved.");
    await w.settled();
    const memory = async (who: Person) =>
      w.json<SpaceMemory>(await as(who, "GET", `/spaces/${spaceId}/memory`));
    expect((await memory(grace)).entries[0]!.thread).toMatchObject({ id: threadId });
    // Ada leaves the space: as the org's owner she still manages it, but reads none of its threads.
    expect((await member(ada, null)).status).toBe(200);
    const owner = await memory(ada);
    expect(owner.canForget).toBe(true);
    expect(owner.entries[0]!.thread).toBeNull();
  });
});
