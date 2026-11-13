// Settings an org keeps for all its spaces and a space keeps for itself, in one table: a row is
// the org's own while its space is null, and a space's row names its org too. Each table declares
// the two columns and the two unique indexes, and its store reads and writes a scope's rows through
// the conditions and values here.

import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { type SQLiteColumn, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { organization } from "@/server/orgs/schema.ts";

import { space } from "./schema.ts";

// Whose setting it is: an org's, for all its spaces, or one space's.
export type SettingScope = { orgId: string } | { spaceId: string };

// The columns a scoped table declares.
export function scopeColumns() {
  return {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Null for the org's own row.
    spaceId: text("space_id").references(() => space.id, { onDelete: "cascade" }),
  };
}

interface Scoped {
  organizationId: SQLiteColumn;
  spaceId: SQLiteColumn;
}

// The indexes that keep one row per scope and key, the key being the columns that name the
// setting: one over the org's own rows, one over the spaces'.
export function scopeIndexes(name: string, table: Scoped, ...key: SQLiteColumn[]) {
  return [
    uniqueIndex(`${name}_org_idx`)
      .on(table.organizationId, ...key)
      .where(sql`${table.spaceId} is null`),
    uniqueIndex(`${name}_space_idx`).on(table.spaceId, ...key),
  ];
}

// Conditions and values for the table's scope columns, for its store's own statements.
export function scopedOn(table: Scoped) {
  return {
    // The scope's own rows.
    at: (scope: SettingScope): SQL =>
      "orgId" in scope
        ? and(eq(table.organizationId, scope.orgId), isNull(table.spaceId))!
        : eq(table.spaceId, scope.spaceId),
    // The scope's columns of a new row; a space's row takes its org from the space.
    of: (scope: SettingScope) =>
      "orgId" in scope
        ? { organizationId: scope.orgId, spaceId: null }
        : {
            organizationId: sql<string>`(select ${space.organizationId} from ${space} where ${space.id} = ${scope.spaceId})`,
            spaceId: scope.spaceId,
          },
    // What a new row of the scope with the same key collides on, to change that row instead.
    conflict: (scope: SettingScope, ...key: SQLiteColumn[]) =>
      "orgId" in scope
        ? { target: [table.organizationId, ...key], targetWhere: sql`${table.spaceId} is null` }
        : { target: [table.spaceId, ...key] },
  };
}
