// A space: a new thread's composer, and its threads by when they were last active, each with the
// start of its newest message, narrowed by title or that message as you type.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { NewThreadComposer } from "@/web/components/draft-thread";
import { ListSkeleton, LoadError, NotFound } from "@/web/components/page-states";
import { ThreadRow } from "@/web/components/thread-row";
import { Time } from "@/web/components/time";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { rememberSpace } from "@/web/lib/last-space";
import { spaceFoldersQuery, spaceThreadsQuery, spacesQuery } from "@/web/lib/queries";
import { sectionOf, SECTIONS } from "@/web/lib/time-sections";

const spaceRoute = getRouteApi("/_app/s/$spaceId");

export function SpacePage() {
  const { spaceId } = spaceRoute.useParams();
  const spaces = useQuery(spacesQuery);
  const threads = useQuery(spaceThreadsQuery(spaceId));
  const folders = useQuery(spaceFoldersQuery(spaceId));
  const [filter, setFilter] = useState("");
  const space = spaces.data?.find((s) => s.id === spaceId);

  useEffect(() => rememberSpace(spaceId), [spaceId]);

  const needle = filter.trim().toLowerCase();
  const shown = threads.data?.filter(
    (thread) =>
      thread.title.toLowerCase().includes(needle) ||
      !!thread.preview?.text.toLowerCase().includes(needle),
  );
  const now = new Date();
  const folderNames = new Map((folders.data ?? []).map((f) => [f.id, f.name]));

  if (spaces.isSuccess && !space) return <NotFound what="space" />;

  return (
    <>
      <PageHeader crumbs={[{ label: space?.name ?? "" }]} />
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4 pb-12")}>
        <NewThreadComposer spaceId={spaceId} />
        <div className="flex flex-col gap-2">
          <InputGroup>
            <InputGroupInput
              type="search"
              placeholder="Filter threads…"
              aria-label="Filter threads"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
          {threads.error && <LoadError />}
          {threads.isPending && <ListSkeleton />}
          <ul className="flex flex-col gap-4" aria-label="Threads">
            {threads.data?.length === 0 && (
              <li className="px-2 text-sm text-muted-foreground">No threads yet.</li>
            )}
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
