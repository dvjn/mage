// A thread in Ada's space, where Grace can post too and Alan can read, with an agent on a model the
// test drives, and ways to read back what happened in it.

import { expect, onTestFinished } from "vite-plus/test";

import { eventSummary } from "@/server/threads/log.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { setup } from "./workspace.ts";
import { personLabel } from "@/shared/people.ts";

export async function agentThread(options: Parameters<typeof setup>[0] = {}) {
  const workspace = setup(options);
  workspace.org.defaultModel = "codex/gpt-big";
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  const grace = workspace.join(
    await workspace.signUp("Grace Hopper", "grace@example.com"),
    space.id,
    "messager",
  );
  const alan = workspace.join(
    await workspace.signUp("Alan Turing", "alan@example.com"),
    space.id,
    "viewer",
  );
  async function post(who: { cookie: string }, text: string, mode = "steer") {
    const res = await workspace.api("POST", `/threads/${thread.id}/messages`, who.cookie, {
      text,
      mode,
    });
    expect(res.status).toBe(202);
    return (await res.json()) as { id: string };
  }
  function events() {
    return workspace.threadStore.eventsAfter(thread.id, 0).map(eventSummary);
  }
  function types() {
    return events().map((event) => event.type);
  }
  // The transcript as people see it: who wrote each row and its text.
  function transcript() {
    return transcriptOf(events()).rows.map((row) =>
      row.kind === "human"
        ? `${personLabel(row.author)}: ${row.text}`
        : row.kind === "agent"
          ? `Agent (${row.status}): ${row.text}`
          : row.kind === "stop"
            ? `stopped by ${row.by}`
            : row.kind === "tool"
              ? `${row.toolId} (${row.state}${row.decision ? ` by ${personLabel(row.decision.by)}` : ""})`
              : row.kind,
    );
  }
  function runs() {
    return workspace.db.all<{ id: string; status: string; reason: string | null; attempt: number }>(
      "select id, status, reason, attempt from run order by id",
    );
  }
  function start(worker = workspace.worker) {
    worker.start();
    onTestFinished(() => worker.stop());
  }
  function pending() {
    return transcriptOf(events()).pending.map(
      (message) => `${personLabel(message.author)} (${message.mode}): ${message.text}`,
    );
  }
  return {
    ...workspace,
    ada,
    grace,
    alan,
    space,
    thread,
    post,
    events,
    types,
    transcript,
    pending,
    runs,
    start,
  };
}
