// A data table read a page at a time from the server, whose page, rows per page, search text and
// filters live in the page's address: the table reads them from the address and writes changes
// back to it, the search text once typing pauses. Changing the search or a filter goes back to the
// first page, and a page past the last, as after removing its last row, gives way to the last.

import {
  type ColumnDef,
  type ColumnFiltersState,
  functionalUpdate,
  type PaginationState,
  type RowData,
  type Updater,
  useTable,
} from "@tanstack/react-table";
import { useEffect, useState } from "react";

import { useDebounced } from "@/web/hooks/use-debounced";
import {
  DEFAULT_PER_PAGE,
  type DataTableFeatures,
  dataTableFeatures,
  type TableSearch,
} from "@/web/lib/data-table";

type Search = TableSearch & Record<string, unknown>;

interface UseDataTableProps<TData extends RowData, TSearch extends Search> {
  columns: ColumnDef<DataTableFeatures, TData>[];
  data: TData[];
  // How many rows match in all, once known.
  rowCount: number | undefined;
  getRowId: (row: TData) => string;
  search: TSearch;
  // Writes changes to the address; unset values leave it.
  onSearch: (changes: Partial<TSearch>) => void;
  // The columns whose filters are kept in the address under their ids.
  filters?: (keyof TSearch & string)[];
  // Columns that only filter, never shown.
  hidden?: string[];
}

export function useDataTable<TData extends RowData, TSearch extends Search>({
  columns,
  data,
  rowCount,
  getRowId,
  search,
  onSearch,
  filters = [],
  hidden = [],
}: UseDataTableProps<TData, TSearch>) {
  const pagination: PaginationState = {
    pageIndex: (search.page ?? 1) - 1,
    pageSize: search.perPage ?? DEFAULT_PER_PAGE,
  };
  const columnFilters: ColumnFiltersState = filters
    .filter((id) => typeof search[id] === "string")
    .map((id) => ({ id, value: search[id] }));

  const write = (changes: Partial<TSearch>) => onSearch({ page: undefined, ...changes });

  // The search text as typed, written to the address once typing pauses, or at once when cleared.
  const q = search.q ?? "";
  const [text, setText] = useState(q);
  const [last, setLast] = useState(q);
  const settled = useDebounced(text);
  // The address changed by other means, as by Reset or going back.
  if (q !== last) {
    setLast(q);
    setText(q);
  }
  useEffect(() => {
    if (settled !== q) write({ q: settled || undefined } as Partial<TSearch>);
    // Only a settled change of the text writes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  function onGlobalFilterChange(updater: Updater<string>) {
    const next = (functionalUpdate(updater, text) as string | undefined) ?? "";
    setText(next);
    if (!next && q) write({ q: undefined } as Partial<TSearch>);
  }

  function onPaginationChange(updater: Updater<PaginationState>) {
    const next = functionalUpdate(updater, pagination);
    onSearch({
      page: next.pageIndex > 0 ? next.pageIndex + 1 : undefined,
      perPage: next.pageSize === DEFAULT_PER_PAGE ? undefined : next.pageSize,
    } as Partial<TSearch>);
  }

  function onColumnFiltersChange(updater: Updater<ColumnFiltersState>) {
    const next = functionalUpdate(updater, columnFilters);
    const changes: Record<string, unknown> = {};
    for (const id of filters) {
      const value = next.find((filter) => filter.id === id)?.value;
      changes[id] = typeof value === "string" ? value : undefined;
    }
    write(changes as Partial<TSearch>);
  }

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    getRowId,
    rowCount: rowCount ?? 0,
    initialState: {
      columnVisibility: Object.fromEntries(hidden.map((id) => [id, false])),
    },
    state: { pagination, columnFilters, globalFilter: text },
    onPaginationChange,
    onColumnFiltersChange,
    onGlobalFilterChange,
    manualPagination: true,
    manualFiltering: true,
  });

  // A page past the last, as after its last row went, shows the last.
  const pageCount = rowCount === undefined ? undefined : Math.ceil(rowCount / pagination.pageSize);
  useEffect(() => {
    if (pageCount === undefined || pagination.pageIndex < Math.max(pageCount, 1)) return;
    onSearch({ page: pageCount > 1 ? pageCount : undefined } as Partial<TSearch>);
  }, [pageCount, pagination.pageIndex, onSearch]);

  return table;
}

export type DataTableInstance<TData extends RowData> = ReturnType<
  typeof useDataTable<TData, Search>
>;
