// Narrows a table: a search, one filter per column that has options, and Reset while anything is
// set; what the caller adds (other narrowing, then the table's one action) follows. On a phone the
// search takes the row and the filters sit below it.

import type { ReactTable, RowData } from "@tanstack/react-table";
import { cn } from "cn";
import { SearchIcon, XIcon } from "lucide-react";
import type * as React from "react";

import { DataTableFacetedFilter } from "@/web/components/data-table/data-table-faceted-filter";
import { Button } from "@/web/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import type { DataTableFeatures } from "@/web/lib/data-table";

interface DataTableToolbarProps<TData extends RowData> extends React.ComponentProps<"div"> {
  table: ReactTable<DataTableFeatures, TData>;
  // The search's label and placeholder.
  search: string;
}

export function DataTableToolbar<TData extends RowData>({
  table,
  search,
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
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    >
      <InputGroup className="h-8 w-full sm:w-56">
        <InputGroupInput
          type="search"
          aria-label={search}
          placeholder={search}
          value={text}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
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
  );
}
