// A page's table of threads, read a page at a time: one column of thread rows, without a header,
// narrowed by the toolbar's search and by All, Needs you or Unread, both kept in the page's
// address. While there are no threads at all it gives way to its empty state, with no
// toolbar.

import type { ColumnDef } from "@tanstack/react-table";
import type * as React from "react";

import type { ThreadShow, ThreadStatus } from "@/shared/thread-status.ts";
import type { ShownModel, ThreadActivity, ThreadParticipants } from "@/shared/threads/list.ts";
import { DataTable, type Empty } from "@/web/components/data-table/data-table";
import { DataTableToolbar } from "@/web/components/data-table/data-table-toolbar";
import { useDataTable } from "@/web/hooks/use-data-table";
import { type DataTableFeatures, type TableSearch, withoutUnset } from "@/web/lib/data-table";
import { filterColumn } from "@/web/shell/people-table";
import { ThreadRow } from "@/web/threads/thread-row";
import { ThreadShowControl } from "@/web/threads/thread-show";

type Thread = {
  id: string;
  title: string;
  untitled: boolean;
  updatedAt: string;
  shownModel: ShownModel | null;
  participants: ThreadParticipants;
  activity: ThreadActivity;
  status: ThreadStatus;
};

type ThreadSearch = TableSearch & { show?: ThreadShow };

export function ThreadTable<T extends Thread, S extends ThreadSearch>({
  label,
  page,
  search,
  onSearch,
  row,
  empty,
}: {
  label: string;
  page: { data?: { items: T[]; total: number }; error: unknown };
  search: S;
  onSearch: (search: (previous: S) => S) => void;
  // What the row says besides the thread itself: where it is and its time.
  row: (thread: T) => { place?: string; time: React.ReactNode };
  empty: Empty;
}) {
  const columns: ColumnDef<DataTableFeatures, T>[] = [
    {
      id: "thread",
      header: "Thread",
      cell: ({ row: { original } }) => <ThreadRow thread={original} {...row(original)} />,
      meta: { className: "p-0" },
    },
    filterColumn<T>("show", "Show"),
  ];
  const table = useDataTable({
    columns,
    data: page.data?.items ?? [],
    rowCount: page.data?.total,
    getRowId: (thread) => thread.id,
    search,
    onSearch: (changes) => onSearch((previous) => withoutUnset({ ...previous, ...changes })),
    filters: ["show"],
    hidden: ["show"],
  });
  const narrowed = !!(search.q || search.show);
  const any = narrowed || !!page.data?.total;
  return (
    <DataTable
      table={table}
      label={label}
      loading={!page.data}
      failed={!!page.error}
      empty={empty}
      header={false}
      rowProps={(thread) => ({ label: thread.title })}
    >
      {any && (
        <DataTableToolbar table={table} search="Filter threads">
          <ThreadShowControl
            value={search.show}
            onChange={(show) => table.getColumn("show")?.setFilterValue(show)}
          />
        </DataTableToolbar>
      )}
    </DataTable>
  );
}
