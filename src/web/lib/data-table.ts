// What the data tables are built from: the TanStack Table features they use, read a page at a time
// and narrowed on the server, and what a column says about itself (its label, the options of its
// filter, and the classes of its header and cells). A table's page, rows per page, search and
// filters live in its page's address; this is that part of the address, read leniently.

import {
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  tableFeatures,
} from "@tanstack/react-table";
import * as z from "zod";

import { PER_PAGE_OPTIONS } from "@/shared/paging.ts";

export interface FilterOption {
  label: string;
  value: string;
}

export interface DataTableColumnMeta {
  // The header, and the name of the column's filter.
  label?: string;
  // A column with options is narrowed to one of them from the toolbar.
  options?: FilterOption[];
  headerClassName?: string;
  className?: string;
}

export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;

export const DEFAULT_PER_PAGE = PER_PAGE_OPTIONS[0];

// A value the address may hold, or nothing when it holds something else.
export function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

// The search text, the page by number and the rows per page.
export const tableSearchSchema = z.object({
  q: lenient(z.string().min(1).max(200)),
  page: lenient(z.coerce.number().int().min(2)),
  perPage: lenient(
    z.coerce
      .number()
      .refine((n): n is (typeof PER_PAGE_OPTIONS)[number] =>
        (PER_PAGE_OPTIONS as readonly number[]).includes(n),
      ),
  ),
});

export type TableSearch = z.infer<typeof tableSearchSchema>;

// The address without the values left unset.
export function withoutUnset<T extends object>(search: T): T {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined && value !== ""),
  ) as T;
}

// What a table's page is read with: the search text and filters, the page and its size.
export function pageQueryOf(search: Record<string, string | number | undefined>) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== "" && key !== "perPage") query[key] = String(value);
  }
  query.perPage = String(search.perPage ?? DEFAULT_PER_PAGE);
  return query;
}
