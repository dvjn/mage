// Shared with you: the threads the signed-in person is a guest in, a page at a time, each with its
// status for them, where it is and when their access ends, most recently active first, narrowed by
// title or place and to those that need them or have something new for them; and, while there are
// none, a note on how threads come to be shared.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";

import { threadShowSchema } from "@/shared/thread-status.ts";
import { PageHeader, pageWidth } from "@/web/app/app-shell";
import { ThreadTable } from "@/web/threads/thread-table";
import { Until } from "@/web/components/time";
import { lenient, tableSearchSchema } from "@/web/lib/data-table";
import { sharedThreadsPage } from "@/web/api/list-queries";

// The search, which threads show, and the page in the address.
export const sharedSearchSchema = tableSearchSchema.extend({ show: lenient(threadShowSchema) });

const sharedRoute = getRouteApi("/_app/shared");

export function SharedPage() {
  const search = sharedRoute.useSearch();
  const navigate = sharedRoute.useNavigate();
  const page = useQuery(sharedThreadsPage(search));
  return (
    <>
      <PageHeader crumbs={[{ label: "Shared with you" }]} />
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4 pb-12")}>
        <ThreadTable
          label="Shared threads"
          page={page}
          search={search}
          onSearch={(next) => void navigate({ search: next, replace: true })}
          row={(thread) => ({ place: thread.place, time: <Until iso={thread.accessUntil} /> })}
          empty={{
            icon: <UsersIcon />,
            title: "Nothing is shared with you yet",
            description:
              "Threads that people outside your spaces share with you appear here. They arrive as invite links; open one to join the thread.",
          }}
        />
      </div>
    </>
  );
}
