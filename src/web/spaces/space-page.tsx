// A space: a new thread's composer for those who can write in it, and its threads a page at a time
// by when they were last active, each with its status for the reader and who has written in it,
// narrowed by title or newest message and to those that need the reader or have something new for
// them. A person's own archived space only lists its threads,
// and may be deleted with them.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArchiveIcon, LockIcon, MessagesSquareIcon, Trash2Icon } from "lucide-react";
import { useEffect } from "react";

import { threadShowSchema } from "@/shared/thread-status.ts";
import { NewThreadComposer } from "@/web/threads/draft-thread";
import { EmptyState } from "@/web/components/page-states";
import { ThreadTable } from "@/web/threads/thread-table";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { lenient, tableSearchSchema } from "@/web/lib/data-table";
import { rememberSpace } from "@/web/spaces/last-space";
import { spaceThreadsPage } from "@/web/api/list-queries";
import { DeleteOwnSpace } from "@/web/spaces/delete-own-space";
import { spacesQuery } from "@/web/spaces/queries";
import { PageHeader, pageWidth } from "@/web/shell/page-header";
import { NotFound } from "@/web/shell/not-found";

const spaceRoute = getRouteApi("/_app/s/$spaceId");

// The search, which threads show, and the page in the address.
export const spaceSearchSchema = tableSearchSchema.extend({ show: lenient(threadShowSchema) });

export function SpacePage() {
  const { spaceId } = spaceRoute.useParams();
  const search = spaceRoute.useSearch();
  const navigate = spaceRoute.useNavigate();
  const spaces = useQuery(spacesQuery);
  const space = spaces.data?.find((s) => s.id === spaceId);
  // A team org's owner who manages the space without being in it does not see its threads.
  const reads = space?.role !== null;
  const archived = !!space?.archived;
  const writes = !!space?.post;
  const page = useQuery({ ...spaceThreadsPage(spaceId)(search), enabled: reads });

  useEffect(() => rememberSpace(spaceId), [spaceId]);

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
      <PageHeader crumbs={[{ label: space?.name ?? "" }]}>
        {space && archived && (
          <div className="px-4">
            <DeleteOwnSpace
              space={space}
              threads={page.data?.total}
              trigger={<Button variant="outline" size="sm" />}
            >
              <Trash2Icon />
              Delete space
            </DeleteOwnSpace>
          </div>
        )}
      </PageHeader>
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4 pb-12")}>
        {writes && <NewThreadComposer spaceId={spaceId} />}
        {archived && (
          <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <ArchiveIcon className="size-4 shrink-0" aria-hidden />
            This space is archived
          </p>
        )}
        <ThreadTable
          label="Threads"
          page={page}
          search={search}
          onSearch={(next) => void navigate({ search: next, replace: true })}
          row={(thread) => ({ time: <Time iso={thread.updatedAt} /> })}
          empty={{
            icon: <MessagesSquareIcon />,
            title: "No threads yet",
            description: archived
              ? undefined
              : writes
                ? "Write above to start one."
                : "Threads show here once someone who can write in this space starts one.",
          }}
        />
      </div>
    </>
  );
}
