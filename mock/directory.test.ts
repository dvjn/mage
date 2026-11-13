import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/server/schema.ts";
import { setup } from "@/server/testing/workspace.ts";

import { pushDirectory } from "./directory.ts";
import { subjectOf } from "./identity.ts";

const people = [
  { userName: "ada", name: "Ada Lovelace", email: "ada@example.com" },
  { userName: "grace", name: "Grace Hopper", email: "grace@example.com" },
];

describe("pushing the stand-in directory", () => {
  it("provisions its people by the subject they sign in with, and its groups with them", async () => {
    const { db, scim } = setup();
    await pushDirectory(scim, people, [
      { name: "Engineering", email: "engineering@example.com", members: ["ada", "grace"] },
    ]);
    const users = db.select().from(schema.scimUser).all();
    expect(users.map((user) => [user.userName, user.externalId])).toEqual(
      expect.arrayContaining([
        ["ada", subjectOf("ada@example.com")],
        ["grace", subjectOf("grace@example.com")],
      ]),
    );
    const [group] = db.select().from(schema.scimGroup).all();
    expect(group).toMatchObject({ displayName: "Engineering", email: "engineering@example.com" });
    expect(
      db
        .select()
        .from(schema.scimGroupMember)
        .where(eq(schema.scimGroupMember.groupId, group!.id))
        .all(),
    ).toHaveLength(2);
  });

  it("changes only what changed when pushed again", async () => {
    const { db, scim } = setup();
    await pushDirectory(scim, people, [{ name: "Engineering", members: ["ada", "grace"] }]);
    const before = db.select().from(schema.scimUser).all();
    await pushDirectory(
      scim,
      [{ ...people[0]!, name: "Augusta Ada King" }, people[1]!],
      [{ name: "Engineering", members: ["grace"] }],
    );
    const after = db.select().from(schema.scimUser).all();
    expect(after.map((user) => user.id).toSorted()).toEqual(
      before.map((user) => user.id).toSorted(),
    );
    expect(after.find((user) => user.userName === "ada")?.displayName).toBe("Augusta Ada King");
    expect(db.select().from(schema.scimGroup).all()).toHaveLength(1);
    expect(db.select().from(schema.scimGroupMember).all()).toHaveLength(1);
  });
});
