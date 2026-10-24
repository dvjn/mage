// A page's table of threads, read a page at a time: one column of thread rows, without a header,
// narrowed by the toolbar's search, by All, Needs you or Unread, and in a space by folder, all kept
// in the page's address. While there are no threads at all it gives way to its empty state, with no
// toolbar.

import type { ColumnDef } from "@tanstack/react-table";
import type * as React from "react";

import type { ThreadShow } from "@/shared/thread-status.ts";
import type { ThreadActivity, ThreadParticipants } from "@/shared/threads.ts";
import { DataTable, type Empty } from "@/web/components/data-table/data-table";
import { DataTableToolbar } from "@/web/components/data-table/data-table-toolbar";
import { filterColumn } from "@/web/components/people-table";
import { ThreadRow } from "@/web/components/thread-row";
import { ThreadShowControl } from "@/web/components/thread-show";
import { useDataTable } from "@/web/hooks/use-data-table";
import {
  type DataTableFeatures,
  type FilterOption,
  type TableSearch,
  withoutUnset,
} from "@/web/lib/data-table";

type Thread = {
  id: string;
  title: string;
  untitled: boolean;
  updatedAt: string;
  participants: ThreadParticipants;
  activity: ThreadActivity;
};

type ThreadSearch = TableSearch & { show?: ThreadShow; folder?: string };

export function ThreadTable<T extends Thread, S extends ThreadSearch>({
  label,
  page,
  search,
  onSearch,
  row,
  folders,
  empty,
}: {
  label: string;
  page: { data?: { items: T[]; total: number }; error: unknown };
  search: S;
  onSearch: (search: (previous: S) => S) => void;
  // What the row says besides the thread itself: where it is, its badge and its time.
  row: (thread: T) => { place?: string; badge?: string; time: React.ReactNode };
  // The space's folders, to narrow to one.
  folders?: FilterOption[];
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
    ...(folders?.length ? [filterColumn<T>("folder", "Folder", folders)] : []),
  ];
  const table = useDataTable({
    columns,
    data: page.data?.items ?? [],
    rowCount: page.data?.total,
    getRowId: (thread) => thread.id,
    search,
    onSearch: (changes) => onSearch((previous) => withoutUnset({ ...previous, ...changes })),
    filters: folders?.length ? ["show", "folder"] : ["show"],
    hidden: ["show", "folder"],
  });
  const narrowed = !!(search.q || search.show || search.folder);
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
