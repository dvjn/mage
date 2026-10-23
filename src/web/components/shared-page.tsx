// Shared with you: the threads the signed-in person is a guest in, each with where it is and when
// their access ends, most recently active first, narrowed by title or place as you type; and, while
// there are none, a note on how threads come to be shared.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { SearchIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { EmptyState, ListSkeleton, LoadError } from "@/web/components/page-states";
import { ThreadRow } from "@/web/components/thread-row";
import { Until } from "@/web/components/time";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { sharedThreadsQuery } from "@/web/lib/queries";

export function SharedPage() {
  const shared = useQuery(sharedThreadsQuery);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = shared.data?.filter(
    (thread) =>
      thread.title.toLowerCase().includes(needle) || thread.place.toLowerCase().includes(needle),
  );
  return (
    <>
      <PageHeader crumbs={[{ label: "Shared with you" }]} />
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4 pb-12")}>
        {shared.error && <LoadError />}
        {shared.isPending && <ListSkeleton />}
        {shared.data?.length === 0 && (
          <EmptyState
            icon={<UsersIcon />}
            title="Nothing is shared with you yet"
            description="Threads that people outside your spaces share with you appear here. They arrive as invite links; open one to join the thread."
          />
        )}
        {!!shared.data?.length && (
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
            <ul className="flex flex-col" aria-label="Shared threads">
              {shown?.length === 0 && (
                <li className="px-2 text-sm text-muted-foreground">No thread matches.</li>
              )}
              {shown?.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  detail={thread.place}
                  time={<Until iso={thread.accessUntil} />}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
