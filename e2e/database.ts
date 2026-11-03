// Where the journeys' server keeps its database, and access to it for arranging what the app has no
// screens for yet, such as making someone a member of another person's space.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export const dataDir = path.join(tmpdir(), "mage-e2e");
export const databasePath = path.join(dataDir, "mage.db");

// The database, waiting out the server's writes rather than failing on them. Transactions here
// take the write lock as they begin, as one that read first would fail at once when it came to write.
function open() {
  return new Database(databasePath, { timeout: 5000 });
}

// A row the server is still committing, such as the primary space of someone who has just signed
// up: their page can see it a moment before the sign-up's transaction ends.
function eventually<T>(read: () => T | undefined): T {
  const until = Date.now() + 2000;
  for (;;) {
    const row = read();
    if (row !== undefined || Date.now() > until) return row as T;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

// Makes the user with `email` a member of the primary space of the user with `ownerEmail`, with
// the role, and points their sessions at that space's org, answering its id. A tab of theirs still
// open names its own org with each request, which points the session back.
export function joinSpaceOf(
  ownerEmail: string,
  email: string,
  role: "messager" | "viewer",
): string {
  const db = open();
  try {
    const userId = (email: string) =>
      (db.prepare("select id from user where email = ?").get(email) as { id: string }).id;
    const owner = userId(ownerEmail);
    const member = userId(email);
    const space = eventually(
      () =>
        db
          .prepare(
            "select id, organization_id as orgId from space where created_by = ? and is_primary = 1",
          )
          .get(owner) as { id: string; orgId: string } | undefined,
    );
    db.transaction(() => {
      db.prepare(
        "insert into member (id, organization_id, user_id, role, direct_role, created_at) values (?, ?, ?, 'member', 'member', ?)",
      ).run(randomUUID(), space.orgId, member, Date.now());
      db.prepare("update session set active_organization_id = ? where user_id = ?").run(
        space.orgId,
        member,
      );
      db.prepare(
        "insert into space_member (space_id, subject_kind, subject_id, role, source) values (?, 'user', ?, ?, 'direct')",
      ).run(space.id, member, role);
    }).immediate();
    return space.orgId;
  } finally {
    db.close();
  }
}

function primarySpaceOf(db: Database.Database, email: string) {
  return eventually(
    () =>
      db
        .prepare(
          "select space.id as id, user.id as userId from space join user on space.created_by = user.id where user.email = ? and space.is_primary = 1",
        )
        .get(email) as { id: string; userId: string } | undefined,
  );
}

// When the last thread added here was last active; each one added after it is newer, so lists
// sorted by it come out the same every time.
let lastAdded = 0;

// Adds `count` threads, titled `${prefix} 1` and on, to the primary space of the user with `email`.
export function addThreads(email: string, count: number, { prefix = "Thread" } = {}) {
  const db = open();
  try {
    const space = primarySpaceOf(db, email);
    db.transaction(() => {
      const insert = db.prepare(
        "insert into thread (id, space_id, title, title_source, created_by, created_at, updated_at) values (?, ?, ?, 'message', ?, ?, ?)",
      );
      for (let index = 1; index <= count; index += 1) {
        lastAdded = Math.max(Date.now(), lastAdded + 1);
        insert.run(
          randomUUID(),
          space.id,
          `${prefix} ${index}`,
          space.userId,
          lastAdded,
          lastAdded,
        );
      }
    }).immediate();
  } finally {
    db.close();
  }
}

// Makes the user with `guestEmail` a guest, with no expiry, in every thread of the primary space of
// the user with `ownerEmail`.
export function shareThreads(ownerEmail: string, guestEmail: string) {
  const db = open();
  try {
    const space = primarySpaceOf(db, ownerEmail);
    const guest = (
      db.prepare("select id from user where email = ?").get(guestEmail) as { id: string }
    ).id;
    db.prepare(
      "insert into thread_guest (thread_id, user_id, invited_by) select id, ?, ? from thread where space_id = ?",
    ).run(guest, space.userId, space.id);
  } finally {
    db.close();
  }
}

// Adds a thread titled `title` to the primary space of the user with `email`, holding `count`
// asides from them, `Note 1` and on, each a few lines long, which they have seen; then `count` more
// from the user with `email` in `unread`, which they have not. Answers its id.
export function addNotesThread(
  email: string,
  title: string,
  count: number,
  unread?: { email: string; count: number },
) {
  const db = open();
  try {
    const space = primarySpaceOf(db, email);
    const other =
      unread &&
      (db.prepare("select id from user where email = ?").get(unread.email) as { id: string }).id;
    const authors = [
      ...Array.from({ length: count }, () => space.userId),
      ...Array.from({ length: unread?.count ?? 0 }, () => other!),
    ];
    const threadId = randomUUID();
    db.transaction(() => {
      lastAdded = Math.max(Date.now(), lastAdded + 1);
      const start = lastAdded - authors.length;
      db.prepare(
        "insert into thread (id, space_id, title, title_source, created_by, last_event_seq, last_message_text, created_at, updated_at) values (?, ?, ?, 'person', ?, ?, ?, ?, ?)",
      ).run(
        threadId,
        space.id,
        title,
        space.userId,
        authors.length,
        `Note ${authors.length}`,
        start,
        lastAdded,
      );
      const insert = db.prepare(
        "insert into thread_event (id, thread_id, seq, type, actor_kind, actor_user_id, data, created_at) values (?, ?, ?, 'message', 'user', ?, ?, ?)",
      );
      authors.forEach((author, index) => {
        const seq = index + 1;
        const text = `Note ${seq}\n\nA line to give it height.\n\nAnd one more.`;
        insert.run(
          randomUUID(),
          threadId,
          seq,
          author,
          JSON.stringify({ parts: [{ type: "text", text }], quiet: true, mode: "steer" }),
          start + seq,
        );
      });
      db.prepare(
        "insert into thread_read (user_id, thread_id, last_seen_seq, seen_at) values (?, ?, ?, ?)",
      ).run(space.userId, threadId, count, lastAdded);
    }).immediate();
    return threadId;
  } finally {
    db.close();
  }
}
