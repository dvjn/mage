// Pages over SQL: rows in the order of a sort key and an id, after a cursor naming the last row
// shown or past the rows of earlier numbered pages, and matching text case-insensitively anywhere
// in a field.

import { type SQL, sql } from "drizzle-orm";

import type { Page, PageParams } from "@/shared/paging.ts";

// The sort key and id of the last row shown, opaque to clients.
function encode(key: string | number, id: string) {
  return Buffer.from(JSON.stringify([key, id])).toString("base64url");
}

function decode(cursor: string | undefined): [string | number, string] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      (typeof value[0] === "string" || typeof value[0] === "number") &&
      typeof value[1] === "string"
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // An unreadable cursor starts from the beginning.
  }
  return null;
}

// Rows of `field` containing the text, ignoring case; true when there is no text.
export function containing(text: string | undefined, ...fields: SQL[]) {
  if (!text) return sql`1 = 1`;
  const pattern = `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`(${sql.join(
    fields.map((field) => sql`lower(${field}) like ${pattern} escape '\\'`),
    sql` or `,
  )})`;
}

// Rows after the cursor in the order of `key`, then `id`.
export function after(cursor: string | undefined, key: SQL, id: SQL) {
  const last = decode(cursor);
  if (!last) return sql`1 = 1`;
  return sql`(${key} > ${last[0]} or (${key} = ${last[0]} and ${id} > ${last[1]}))`;
}

// The page's rows and one more, which tells whether another page follows.
export function pageLimit(params: PageParams) {
  return sql`limit ${params.limit + 1} offset ${params.offset ?? 0}`;
}

// A page of `rows`, fetched one past the limit, and the count of every match.
export function pageOf<T>(
  rows: T[],
  params: PageParams,
  total: number,
  keyOf: (row: T) => [string | number, string],
): Page<T> {
  const items = rows.slice(0, params.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > params.limit && last ? encode(...keyOf(last)) : null,
    total,
  };
}
