// Arranges what the app has no screens for yet, through the routes the journeys' server has for
// it, and asks the server whether its data still holds together once they are done.

import { passwordServer } from "./servers.ts";

async function seed<T>(input: object): Promise<T> {
  const response = await fetch(`${passwordServer}/api/test/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`seeding failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

// Makes the user with `email` a member of the primary space of the user with `ownerEmail`, with
// the role, and points their sessions at that space's org, answering its id. A tab of theirs still
// open names its own org with each request, which points the session back.
export async function joinSpaceOf(ownerEmail: string, email: string, role: "messager" | "viewer") {
  const { orgId } = await seed<{ orgId: string }>({ joinSpace: { ownerEmail, email, role } });
  return orgId;
}

// Adds `count` threads, titled `${prefix} 1` and on, to the primary space of the user with `email`,
// each newer than the last.
export async function addThreads(email: string, count: number, { prefix = "Thread" } = {}) {
  await seed({ threads: { email, count, prefix } });
}

// Makes the user with `guestEmail` a guest, with no expiry, in every thread of the primary space of
// the user with `ownerEmail`.
export async function shareThreads(ownerEmail: string, guestEmail: string) {
  await seed({ shareThreads: { ownerEmail, guestEmail } });
}

// Adds a thread titled `title` to the primary space of the user with `email`, holding `count`
// asides from them, `Note 1` and on, each a few lines long, which they have seen; then `count` more
// from the user with `email` in `unread`, which they have not. Answers its id.
export async function addNotesThread(
  email: string,
  title: string,
  count: number,
  unread?: { email: string; count: number },
) {
  const { threadId } = await seed<{ threadId: string }>({
    notesThread: { email, title, count, ...(unread && { unread }) },
  });
  return threadId;
}

// The rules the journeys left the server's data breaking; none when it is sound.
export async function brokenRules(server: string = passwordServer) {
  const response = await fetch(`${server}/api/test/invariants`);
  if (!response.ok) throw new Error(`could not check the data: ${response.status}`);
  return ((await response.json()) as { violations: unknown[] }).violations;
}
