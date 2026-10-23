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

// Makes the user with `email` a member of the primary space of the user with `ownerEmail`, with
// the role, acting from then on in that space's org.
export function joinSpaceOf(ownerEmail: string, email: string, role: "messager" | "viewer") {
  const db = open();
  try {
    const userId = (email: string) =>
      (db.prepare("select id from user where email = ?").get(email) as { id: string }).id;
    const owner = userId(ownerEmail);
    const member = userId(email);
    const space = db
      .prepare(
        "select id, organization_id as orgId from space where created_by = ? and is_primary = 1",
      )
      .get(owner) as { id: string; orgId: string };
    db.transaction(() => {
      db.prepare(
        "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, 'member', ?)",
      ).run(randomUUID(), space.orgId, member, Date.now());
      db.prepare("update session set active_organization_id = ? where user_id = ?").run(
        space.orgId,
        member,
      );
      db.prepare(
        "insert into space_member (space_id, subject_kind, subject_id, role, source) values (?, 'user', ?, ?, 'direct')",
      ).run(space.id, member, role);
    }).immediate();
  } finally {
    db.close();
  }
}

function primarySpaceOf(db: Database.Database, email: string) {
  return db
    .prepare(
      "select space.id as id, user.id as userId from space join user on space.created_by = user.id where user.email = ? and space.is_primary = 1",
    )
    .get(email) as { id: string; userId: string };
}

// Adds `count` threads, titled `${prefix} 1` and on, to the primary space of the user with `email`,
// in the folder named `folder` (made if missing) when one is given.
export function addThreads(
  email: string,
  count: number,
  { prefix = "Thread", folder }: { prefix?: string; folder?: string } = {},
) {
  const db = open();
  try {
    const space = primarySpaceOf(db, email);
    db.transaction(() => {
      let folderId: string | null = null;
      if (folder) {
        folderId =
          (
            db
              .prepare("select id from folder where space_id = ? and name = ?")
              .get(space.id, folder) as { id: string } | undefined
          )?.id ?? null;
        if (!folderId) {
          folderId = randomUUID();
          db.prepare("insert into folder (id, space_id, name, created_by) values (?, ?, ?, ?)").run(
            folderId,
            space.id,
            folder,
            space.userId,
          );
        }
      }
      const insert = db.prepare(
        "insert into thread (id, space_id, title, title_source, created_by, folder_id) values (?, ?, ?, 'message', ?, ?)",
      );
      for (let index = 1; index <= count; index += 1) {
        insert.run(randomUUID(), space.id, `${prefix} ${index}`, space.userId, folderId);
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
