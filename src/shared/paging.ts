// Pages of long lists, shared by the server and the web client: what a list is asked for (text to
// search, how many, after which cursor) and what comes back (the rows, the cursor to the next page
// and how many rows match in all).

import * as z from "zod";

export const PAGE_LIMIT = 50;

export const pageQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(1000).optional(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number() });
}

export interface PageParams {
  q?: string;
  limit: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

// The page asked for, with a limit, from a query's text.
export function pageParams(query: { q?: string; limit?: number; cursor?: string }): PageParams {
  return {
    ...(query.q?.trim() && { q: query.q.trim() }),
    limit: query.limit ?? PAGE_LIMIT,
    ...(query.cursor && { cursor: query.cursor }),
  };
}
