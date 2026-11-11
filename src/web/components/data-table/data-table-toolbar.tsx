// Narrows a table: a search, one filter per column that has options, and Reset while anything is
// set, then what the caller adds as other narrowing; the table's one action sits at the row's right
// end. On a phone the search shares the first line with the action and the filters sit below it.

import type { ReactTable, RowData } from "@tanstack/react-table";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { DataTableFacetedFilter } from "@/web/components/data-table/data-table-faceted-filter";
import { Button } from "@/web/components/ui/button";
import { FilterInput } from "@/web/components/filter-input";
import type { DataTableFeatures } from "@/web/lib/data-table";

interface DataTableToolbarProps<TData extends RowData> extends React.ComponentProps<"div"> {
  table: ReactTable<DataTableFeatures, TData>;
  // The search's label and placeholder.
  search: string;
  action?: React.ReactNode;
}

export function DataTableToolbar<TData extends RowData>({
  table,
  search,
  action,
  children,
  className,
  ...props
}: DataTableToolbarProps<TData>) {
  const columns = table
    .getAllColumns()
    .filter((column) => !!column.columnDef.meta?.options?.length);
  const text = (table.state.globalFilter as string | undefined) ?? "";
  const filtered = !!text || table.state.columnFilters.length > 0;

  function reset() {
    table.resetColumnFilters(true);
    table.resetGlobalFilter(true);
  }

  return (
    <div
      data-slot="data-table-toolbar"
      className={cn("flex items-start gap-2", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <FilterInput
          label={search}
          value={text}
          onChange={(next) => table.setGlobalFilter(next)}
          className="w-full sm:w-56"
        />
        {columns.map((column) => (
          <DataTableFacetedFilter
            key={column.id}
            column={column}
            title={column.columnDef.meta?.label ?? column.id}
            options={column.columnDef.meta?.options ?? []}
          />
        ))}
        {filtered && (
          <Button variant="ghost" onClick={reset}>
            <XIcon />
            Reset
          </Button>
        )}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
