// A space: a new thread's composer for those who can write in it, and its threads a page at a time
// by when they were last active, each with its status for the reader and who has written in it,
// narrowed by title or newest message, to one folder, once there are any, and to those that need
// the reader or have something new for them.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { LockIcon, MessagesSquareIcon } from "lucide-react";
import { useEffect } from "react";
import * as z from "zod";

import { threadShowSchema } from "@/shared/thread-status.ts";
import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { NewThreadComposer } from "@/web/components/draft-thread";
import { EmptyState, NotFound } from "@/web/components/page-states";
import { ThreadTable } from "@/web/components/thread-table";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { lenient, tableSearchSchema } from "@/web/lib/data-table";
import { rememberSpace } from "@/web/lib/last-space";
import { spaceThreadsPage } from "@/web/lib/list-queries";
import { spaceFoldersQuery, spacesQuery } from "@/web/lib/queries";

const spaceRoute = getRouteApi("/_app/s/$spaceId");

// The folder, search, which threads show, and the page in the address.
export const spaceSearchSchema = tableSearchSchema.extend({
  folder: lenient(z.string().min(1).max(100)),
  show: lenient(threadShowSchema),
});

export function SpacePage() {
  const { spaceId } = spaceRoute.useParams();
  const search = spaceRoute.useSearch();
  const navigate = spaceRoute.useNavigate();
  const spaces = useQuery(spacesQuery);
  const space = spaces.data?.find((s) => s.id === spaceId);
  // A team org's owner who manages the space without being in it does not see its threads.
  const reads = space?.role !== null;
  const writes = space?.role === "owner" || space?.role === "messager";
  const page = useQuery({ ...spaceThreadsPage(spaceId)(search), enabled: reads });
  const folders = useQuery({ ...spaceFoldersQuery(spaceId), enabled: reads });

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  const folderNames = new Map((folders.data ?? []).map((f) => [f.id, f.name]));

  if (spaces.isSuccess && !space) return <NotFound what="space" id={spaceId} />;
  if (space && space.role === null) {
    return (
      <>
        <PageHeader crumbs={[{ label: space.name }]} />
        <div className={cn(pageWidth, "flex flex-col gap-6 p-4 pb-12")}>
          <EmptyState
            icon={<LockIcon />}
            title="You are not in this space"
            description="As an owner of the organization you manage it, but its threads stay hidden until you add yourself."
            action={
              <Button
                variant="outline"
                render={<Link to="/s/$spaceId/settings" params={{ spaceId }} />}
                nativeButton={false}
              >
                Open space settings
              </Button>
            }
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader crumbs={[{ label: space?.name ?? "" }]} />
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4 pb-12")}>
        {writes && <NewThreadComposer spaceId={spaceId} />}
        <ThreadTable
          label="Threads"
          page={page}
          search={search}
          onSearch={(next) => void navigate({ search: next, replace: true })}
          row={(thread) => ({
            badge: folderNames.get(thread.folderId ?? ""),
            time: <Time iso={thread.updatedAt} />,
          })}
          folders={(folders.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
          empty={{
            icon: <MessagesSquareIcon />,
            title: "No threads yet",
            description: writes
              ? "Write above to start one."
              : "Threads show here once someone who can write in this space starts one.",
          }}
        />
      </div>
    </>
  );
}
