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
    const users = await db.select().from(schema.scimUser);
    expect(users.map((user) => [user.userName, user.externalId])).toEqual(
      expect.arrayContaining([
        ["ada", subjectOf("ada@example.com")],
        ["grace", subjectOf("grace@example.com")],
      ]),
    );
    const [group] = await db.select().from(schema.scimGroup);
    expect(group).toMatchObject({ displayName: "Engineering", email: "engineering@example.com" });
    expect(
      await db
        .select()
        .from(schema.scimGroupMember)
        .where(eq(schema.scimGroupMember.groupId, group!.id)),
    ).toHaveLength(2);
  });

  it("changes only what changed when pushed again", async () => {
    const { db, scim } = setup();
    await pushDirectory(scim, people, [{ name: "Engineering", members: ["ada", "grace"] }]);
    const before = await db.select().from(schema.scimUser);
    await pushDirectory(
      scim,
      [{ ...people[0]!, name: "Augusta Ada King" }, people[1]!],
      [{ name: "Engineering", members: ["grace"] }],
    );
    const after = await db.select().from(schema.scimUser);
    expect(after.map((user) => user.id).toSorted()).toEqual(
      before.map((user) => user.id).toSorted(),
    );
    expect(after.find((user) => user.userName === "ada")?.displayName).toBe("Augusta Ada King");
    expect(await db.select().from(schema.scimGroup)).toHaveLength(1);
    expect(await db.select().from(schema.scimGroupMember)).toHaveLength(1);
  });
});
