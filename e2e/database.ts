// Where the journeys' server keeps its database, and access to it for arranging what the app has no
// screens for yet, such as making someone a member of another person's space.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export const dataDir = path.join(tmpdir(), "mage-e2e");
export const databasePath = path.join(dataDir, "mage.db");

// Makes the user with `email` a member of the primary space of the user with `ownerEmail`, with
// the role, acting from then on in that space's org.
export function joinSpaceOf(ownerEmail: string, email: string, role: "messager" | "viewer") {
  const db = new Database(databasePath);
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
    })();
  } finally {
    db.close();
  }
}
