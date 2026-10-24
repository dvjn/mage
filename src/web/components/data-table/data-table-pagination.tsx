// A table's footer: which rows of how many the page shows ("26–50 of 312"), how many rows a page
// holds, which page of how many this is, and the first, previous, next and last pages. Hidden while
// every row fits on the first page.

import type { ReactTable, RowData } from "@tanstack/react-table";
import { cn } from "cn";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react";
import type * as React from "react";
import { useId } from "react";

import { PER_PAGE_OPTIONS } from "@/shared/paging.ts";
import { Button } from "@/web/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { WithTooltip } from "@/web/components/with-tooltip";
import type { DataTableFeatures } from "@/web/lib/data-table";

interface DataTablePaginationProps<TData extends RowData> extends React.ComponentProps<"div"> {
  table: ReactTable<DataTableFeatures, TData>;
}

export function DataTablePagination<TData extends RowData>({
  table,
  className,
  ...props
}: DataTablePaginationProps<TData>) {
  const pageSizeLabelId = useId();
  const { pageIndex, pageSize } = table.state.pagination;
  const pageCount = table.getPageCount();
  const rowCount = table.getRowCount();
  if (pageCount <= 1 && pageIndex === 0) return null;
  const first = Math.min(pageIndex * pageSize + 1, rowCount);
  const last = Math.min((pageIndex + 1) * pageSize, rowCount);

  return (
    <div
      data-slot="data-table-pagination"
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1 text-sm",
        className,
      )}
      {...props}
    >
      <div role="status" className="whitespace-nowrap text-muted-foreground tabular-nums">
        {first}–{last} of {rowCount}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <p id={pageSizeLabelId} className="whitespace-nowrap text-muted-foreground">
            Rows per page
          </p>
          <Select
            value={`${pageSize}`}
            onValueChange={(value) => {
              if (value == null) return;
              table.setPageSize(Number(value));
            }}
          >
            <SelectTrigger size="sm" aria-labelledby={pageSizeLabelId} className="w-18">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top" alignItemWithTrigger={false}>
              <SelectGroup>
                {PER_PAGE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={`${size}`}>
                    {size}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="font-medium whitespace-nowrap tabular-nums">
          Page {pageIndex + 1} of {Math.max(pageCount, 1)}
        </div>
        <div className="flex items-center gap-1">
          <PageButton
            label="First page"
            className="hidden sm:inline-flex"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.setPageIndex(0)}
          >
            <ChevronsLeftIcon />
          </PageButton>
          <PageButton
            label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon />
          </PageButton>
          <PageButton
            label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRightIcon />
          </PageButton>
          <PageButton
            label="Last page"
            className="hidden sm:inline-flex"
            disabled={!table.getCanNextPage()}
            onClick={() => table.setPageIndex(pageCount - 1)}
          >
            <ChevronsRightIcon />
          </PageButton>
        </div>
      </div>
    </div>
  );
}

function PageButton({
  label,
  className,
  ...props
}: { label: string } & React.ComponentProps<typeof Button>) {
  return (
    <WithTooltip label={label}>
      <Button
        aria-label={label}
        variant="outline"
        size="icon-sm"
        className={className}
        {...props}
      />
    </WithTooltip>
  );
}
