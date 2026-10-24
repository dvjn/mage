// A table read a page at a time from the server: its toolbar above, a header row (hidden on a
// phone, where rows fold their columns), its rows, and the page's footer. Each row can open what it
// stands for on a click outside its controls. While nothing matches it gives way to an empty state,
// and while a search or filter is what leaves it empty, to one with Reset.

import { FlexRender, type ReactTable, type Row, type RowData } from "@tanstack/react-table";
import { cn } from "cn";
import { SearchXIcon } from "lucide-react";
import type * as React from "react";

import { DataTablePagination } from "@/web/components/data-table/data-table-pagination";
import { EmptyState, ListSkeleton, LoadError } from "@/web/components/page-states";
import { Button } from "@/web/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import type { DataTableFeatures } from "@/web/lib/data-table";

export interface Empty {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export interface RowProps {
  label: string;
  // Opens what the row stands for, on a click anywhere outside its controls.
  onOpen?: () => void;
  className?: string;
}

interface DataTableProps<TData extends RowData> extends React.ComponentProps<"div"> {
  table: ReactTable<DataTableFeatures, TData>;
  label: string;
  // Whether the page is being read for the first time, or could not be.
  loading: boolean;
  failed: boolean;
  empty: Empty;
  rowProps?: (row: TData) => RowProps;
  // A table of one column, such as a list of threads, has no header.
  header?: boolean;
}

export function DataTable<TData extends RowData>({
  table,
  label,
  loading,
  failed,
  empty,
  rowProps,
  header = true,
  children,
  className,
  ...props
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows;
  const filtered = !!table.state.globalFilter || table.state.columnFilters.length > 0;

  function reset() {
    table.resetColumnFilters(true);
    table.resetGlobalFilter(true);
  }

  return (
    <div data-slot="data-table" className={cn("flex w-full flex-col gap-2", className)} {...props}>
      {children}
      {failed ? (
        <LoadError />
      ) : loading ? (
        <ListSkeleton />
      ) : rows.length === 0 && filtered ? (
        <EmptyState
          icon={<SearchXIcon />}
          title="No matches"
          description="Nothing here matches the search and filters."
          action={
            <Button variant="outline" onClick={reset}>
              Reset
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState {...empty} />
      ) : (
        <Table aria-label={label}>
          {header && (
            <TableHeader className="hidden sm:table-header-group">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((head) => (
                    <TableHead
                      key={head.id}
                      colSpan={head.colSpan}
                      className={cn(
                        "px-3 text-xs text-muted-foreground",
                        head.column.columnDef.meta?.headerClassName,
                      )}
                    >
                      {head.isPlaceholder ? null : <FlexRender header={head} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
          )}
          <TableBody>
            {rows.map((row) => (
              <DataTableRow key={row.id} row={row} {...rowProps?.(row.original)} />
            ))}
          </TableBody>
        </Table>
      )}
      <DataTablePagination table={table} />
    </div>
  );
}

function DataTableRow<TData extends RowData>({
  row,
  label,
  onOpen,
  className,
}: { row: Row<DataTableFeatures, TData> } & Partial<RowProps>) {
  return (
    <TableRow
      aria-label={label}
      className={cn("group", onOpen && "cursor-pointer", className)}
      onClick={
        onOpen &&
        ((event) => {
          if ((event.target as HTMLElement).closest("button, a, [role=combobox]")) return;
          onOpen();
        })
      }
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
          <FlexRender cell={cell} />
        </TableCell>
      ))}
    </TableRow>
  );
}
