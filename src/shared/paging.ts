// Pages of long lists, shared by the server and the web client: what a list is asked for (text to
// search, how many, and after which cursor or on which numbered page) and what comes back (the rows,
// the cursor to the next page and how many rows match in all).

import * as z from "zod";

export const PAGE_LIMIT = 50;

// How many rows a table's page may hold.
export const PER_PAGE_OPTIONS = [25, 50, 100] as const;

export const pageQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(1000).optional(),
});

// A table's page: its text, and the page by number with how many rows each holds.
export const tableQuerySchema = z.object({
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  perPage: z.coerce.number().int().min(1).max(200).optional(),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number() });
}

export interface PageParams {
  q?: string;
  limit: number;
  cursor?: string;
  // How many rows come before the page.
  offset?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

// The page asked for, with a limit, from a query's text.
export function pageParams(query: {
  q?: string;
  limit?: number;
  cursor?: string;
  page?: number;
  perPage?: number;
}): PageParams {
  const limit = query.perPage ?? query.limit ?? PAGE_LIMIT;
  return {
    ...(query.q?.trim() && { q: query.q.trim() }),
    limit,
    ...(query.cursor && { cursor: query.cursor }),
    ...(query.page && query.page > 1 && { offset: (query.page - 1) * limit }),
  };
}

// The page of a list already in hand.
export function pageOfList<T>(list: T[], params: PageParams): Page<T> {
  const start = params.offset ?? 0;
  return { items: list.slice(start, start + params.limit), nextCursor: null, total: list.length };
}
