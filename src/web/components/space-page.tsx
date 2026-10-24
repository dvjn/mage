// A space: a new thread's composer for those who can write in it, and its threads by when they were
// last active, each with the start of its newest message, narrowed by title or that message as you
// type, and to one folder, once there are any.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { LockIcon, MessagesSquareIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { NewThreadComposer } from "@/web/components/draft-thread";
import { EmptyState, ListSkeleton, LoadError, NotFound } from "@/web/components/page-states";
import { Button } from "@/web/components/ui/button";
import { FilterButton } from "@/web/components/table-toolbar";
import { ThreadRow } from "@/web/components/thread-row";
import { Time } from "@/web/components/time";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { rememberSpace } from "@/web/lib/last-space";
import { spaceFoldersQuery, spaceThreadsQuery, spacesQuery } from "@/web/lib/queries";
import { sectionOf, SECTIONS } from "@/web/lib/time-sections";

const spaceRoute = getRouteApi("/_app/s/$spaceId");

export function SpacePage() {
  const { spaceId } = spaceRoute.useParams();
  const { folder } = spaceRoute.useSearch();
  const navigate = spaceRoute.useNavigate();
  const spaces = useQuery(spacesQuery);
  const space = spaces.data?.find((s) => s.id === spaceId);
  // A team org's owner who manages the space without being in it does not see its threads.
  const reads = space?.role !== null;
  const writes = space?.role === "owner" || space?.role === "messager";
  const threads = useQuery({ ...spaceThreadsQuery(spaceId), enabled: reads });
  const folders = useQuery({ ...spaceFoldersQuery(spaceId), enabled: reads });
  const [filter, setFilter] = useState("");

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  const needle = filter.trim().toLowerCase();
  const shown = threads.data?.filter(
    (thread) =>
      (!folder || thread.folderId === folder) &&
      (thread.title.toLowerCase().includes(needle) ||
        !!thread.preview?.text.toLowerCase().includes(needle)),
  );
  const now = new Date();
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
        <div className="flex flex-col gap-2">
          {!!threads.data?.length && (
            <div className="flex gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  type="search"
                  placeholder="Filter threads"
                  aria-label="Filter threads"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
              {!!folders.data?.length && (
                <FilterButton
                  filter={{
                    label: "Folder",
                    value: folder,
                    options: folders.data.map((f) => ({ value: f.id, label: f.name })),
                    onChange: (value) =>
                      void navigate({ search: value ? { folder: value } : {}, replace: true }),
                  }}
                />
              )}
            </div>
          )}
          {threads.error && <LoadError />}
          {threads.isPending && <ListSkeleton />}
          {threads.data?.length === 0 && (
            <EmptyState
              icon={<MessagesSquareIcon />}
              title="No threads yet"
              description={
                writes
                  ? "Write above to start one."
                  : "Threads show here once someone who can write in this space starts one."
              }
            />
          )}
          <ul className="flex flex-col gap-4" aria-label="Threads">
            {!!threads.data?.length && shown?.length === 0 && (
              <li className="px-2 text-sm text-muted-foreground">No thread matches.</li>
            )}
            {SECTIONS.map((section) => {
              const list = shown?.filter((t) => sectionOf(t.updatedAt, now) === section) ?? [];
              if (list.length === 0) return null;
              return (
                <li key={section} className="flex flex-col gap-0.5">
                  <h3 className="px-2 pb-1 text-xs text-muted-foreground">{section}</h3>
                  <ul aria-label={section} className="flex flex-col">
                    {list.map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        thread={thread}
                        detail={
                          thread.preview && `${thread.preview.author}: ${thread.preview.text}`
                        }
                        badge={folderNames.get(thread.folderId ?? "")}
                        time={<Time iso={thread.updatedAt} />}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </>
  );
}
