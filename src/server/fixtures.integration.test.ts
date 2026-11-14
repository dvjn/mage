// The made-up thread logs as the server shows them to each kind of reader: their rows with what
// the reader may do from each, what waits, and the run. What comes out is kept beside the logs,
// so a change to how any stored shape reads through the API shows as a diff.

import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { threadFixtures } from "@/shared/fixtures/threads.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { RowsPage } from "@/shared/threads/rows.ts";

// The logs read through the API: between them every state of a call, every notice and the rows
// of a thread's history.
const SHOWN = ["tools", "notices", "history", "open"];

const PEOPLE = { ada: "ada@example.com", grace: "grace@example.com", alan: "alan@example.com" };

async function seeded(name: string) {
  const t = await agentThread();
  const res = await t.app.request("/api/test/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: {
        email: PEOPLE.ada,
        title: name,
        events: threadFixtures[name],
        people: PEOPLE,
      },
    }),
  });
  expect(res.status).toBe(200);
  const { threadId, ids } = (await res.json()) as { threadId: string; ids: Record<string, string> };
  // What the server made up, by the names the log knows them under.
  const names = new Map<string, string>([
    [threadId, "thread"],
    [t.ada.userId, "ada"],
    [t.grace.userId, "grace"],
    [t.alan.userId, "alan"],
    ...Object.entries(ids).map(([given, stored]): [string, string] => [stored, given]),
  ]);
  const named = (value: unknown) => {
    let text = JSON.stringify(value, null, 2);
    for (const [made, name] of names) text = text.replaceAll(made, name);
    return JSON.parse(text) as unknown;
  };
  // The thread as the reader's page reads it, and every page of rows before the one it opens on.
  async function read(who: { cookie: string }) {
    const detail = (await (
      await t.api("GET", `/threads/${threadId}`, who.cookie)
    ).json()) as ThreadDetail;
    const pages: RowsPage[] = [];
    for (let before = detail.before; before !== null;) {
      const page = (await (
        await t.api("GET", `/threads/${threadId}/rows?before=${before}`, who.cookie)
      ).json()) as RowsPage;
      pages.push(page);
      before = page.before;
    }
    const { rows, waiting, run, before, newFrom, earlierUnread, can, access } = detail;
    return named({ access, can, rows, waiting, run, before, newFrom, earlierUnread, pages });
  }
  return { owner: await read(t.ada), messager: await read(t.grace), viewer: await read(t.alan) };
}

describe("thread fixtures through the API", () => {
  for (const name of SHOWN) {
    it(`${name} reads to each reader as kept`, async () => {
      await expect(`${JSON.stringify(await seeded(name), null, 2)}\n`).toMatchFileSnapshot(
        `../shared/fixtures/golden/api/${name}.json`,
      );
    });
  }
});
