// Learned skills as their clients meet them: the agent saves a skill, which waits for approval as
// a memory save does; once approved, the space lists it as learned and a new thread runs it as a
// command. Everything is arranged and read through the API and through what the model is sent.

import { describe, it } from "vite-plus/test";

import type { ThreadBody } from "@/server/testing/workspace.ts";
import { SAVE_SKILL } from "@/shared/memory.ts";
import { LOAD_SKILL, type SpaceSkillList } from "@/shared/skills.ts";
import type { ThreadCommand } from "@/shared/threads/commands.ts";

import { eventually, expect, type World, world } from "@/server/testing/contract.ts";

const NOTES = {
  name: "deploy-notes",
  description: "Write the notes for a deploy",
  instructions: "Read the merged changes, then write one line each.",
};

describe("learned skills", () => {
  it("are saved once approved, listed as learned, and run as a command in a new thread", async () => {
    const w = await world();
    const res = await w.api("POST", `/spaces/${w.spaceId}/threads`, w.ada.cookie, {
      text: "Keep how we write deploy notes",
    });
    const threadId = (await w.json<ThreadBody>(res)).id;
    const { ids } = await w.asks(threadId, [SAVE_SKILL, NOTES]);
    const call = async () =>
      (await w.detail(w.ada, threadId)).rows.find(
        (row) => row.kind === "tool" && row.id === ids[0],
      );
    await eventually(call, (row) => (row as { state?: string } | undefined)?.state === "waiting");
    expect(await w.decide(w.ada, ids[0]!, true, "once", threadId)).toBe(200);
    const told = await w.answers(threadId, "Saved.");
    await w.settled();
    expect(
      told.request.messages
        .flatMap((message) => (message.role === "tool" ? message.results : []))
        .at(-1)?.output,
    ).toEqual({
      ok: true,
      value: {
        name: "deploy-notes",
        note: "Usable now; listed in this thread's instructions after /reload.",
      },
    });

    const skills = await w.json<SpaceSkillList>(
      await w.api("GET", `/spaces/${w.spaceId}/skills`, w.ada.cookie),
    );
    expect(skills.own.written).toMatchObject([
      {
        name: "deploy-notes",
        learned: {
          thread: { id: threadId, title: "Keep how we write deploy notes" },
          approvedBy: "Ada Lovelace",
        },
      },
    ]);

    const started = await w.api("POST", `/spaces/${w.spaceId}/threads`, w.ada.cookie, {
      text: "/deploy-notes",
      command: { name: "deploy-notes", args: "" },
    });
    const next = (await w.json<ThreadBody>(started)).id;
    const ran = await w.answers(next, "Notes written.");
    expect(ran.texts[0]).toContain("This runs the skill deploy-notes.");
    expect(ran.texts[0]).toContain(NOTES.instructions);
    expect(ran.request.instructions).toMatch(/- deploy-notes: Write the notes for a deploy/);
    await w.settled();
  });

  it("are offered, used and suggested nowhere while the org does not let spaces add skills", async () => {
    const w = await world();
    const first = await w.api("POST", `/spaces/${w.spaceId}/threads`, w.ada.cookie, {
      text: "Keep this",
    });
    const kept = (await w.json<ThreadBody>(first)).id;
    const { ids } = await w.asks(kept, [SAVE_SKILL, NOTES]);
    const call = async () =>
      (await w.detail(w.ada, kept)).rows.find((row) => row.kind === "tool" && row.id === ids[0]);
    await eventually(call, (row) => (row as { state?: string } | undefined)?.state === "waiting");
    expect(await w.decide(w.ada, ids[0]!, true, "once", kept)).toBe(200);
    await w.answers(kept, "Saved.");
    await w.settled();
    const off = await w.api("PUT", "/org/skills/space-skills", w.ada.cookie, { allowed: false });
    expect(off.status).toBe(200);

    const commands = await w.json<ThreadCommand[]>(
      await w.api("GET", `/spaces/${w.spaceId}/commands`, w.ada.cookie),
    );
    expect(commands.map((command) => command.name)).not.toContain("deploy-notes");
    const refused = await w.api("POST", `/spaces/${w.spaceId}/threads`, w.ada.cookie, {
      text: "/deploy-notes",
      command: { name: "deploy-notes", args: "" },
    });
    expect(refused.status).toBe(400);

    const threadId = await started(w, "Reflect");
    const { ids: loads } = await w.asks(
      threadId,
      [LOAD_SKILL, { name: "deploy-notes" }],
      [LOAD_SKILL, { name: "reflect" }],
    );
    expect(loads).toHaveLength(2);
    const told = await w.answers(threadId, "Loaded.");
    expect(told.tools).not.toContain(SAVE_SKILL);
    expect(told.request.instructions).not.toMatch(/deploy-notes/);
    const [missing, reflect] = told.request.messages
      .flatMap((message) => (message.role === "tool" ? message.results : []))
      .map((result) => result.output as { ok: boolean; value?: { instructions: string } });
    expect(missing!.ok).toBe(false);
    expect(reflect!.value!.instructions).not.toMatch(/## Skills|space__save_skill|space-skills/);
    await w.settled();
  });

  it("refuse files at paths not written plainly, or past their size", async () => {
    const w = await world();
    const threadId = await started(w, "Keep this");
    const big = "x".repeat(512 * 1024 + 1);
    await w.asks(
      threadId,
      [SAVE_SKILL, { ...NOTES, files: [{ path: "./run.py", text: "1" }] }],
      [SAVE_SKILL, { ...NOTES, files: [{ path: "a//run.py", text: "1" }] }],
      [SAVE_SKILL, { ...NOTES, files: [{ path: "../run.py", text: "1" }] }],
      [SAVE_SKILL, { ...NOTES, files: [{ path: "run.py", text: big }] }],
    );
    const told = await w.answers(threadId, "Refused.");
    await w.settled();
    const results = told.request.messages
      .flatMap((message) => (message.role === "tool" ? message.results : []))
      .map((result) => (result.output as { ok: boolean }).ok);
    expect(results).toEqual([false, false, false, false]);
  });
});

// A thread Ada starts in the space with the message, answering its id.
async function started(w: World, text: string) {
  const res = await w.api("POST", `/spaces/${w.spaceId}/threads`, w.ada.cookie, { text });
  return (await w.json<ThreadBody>(res)).id;
}
