// Shared with you: the threads the signed-in person is a guest in, each with the space and org it
// belongs to and when their access ends, most recently active first; and, while there are none, a
// note on how threads come to be shared.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";
import { Until } from "@/web/components/time";
import { sharedThreadsQuery } from "@/web/lib/queries";

export function SharedPage() {
  const shared = useQuery(sharedThreadsQuery);
  return (
    <>
      <PageHeader crumbs={[{ label: "Shared with you" }]} />
      <div className={cn(pageWidth, "flex flex-col gap-6 p-4")}>
        {shared.data?.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
              <UsersIcon className="size-5 text-muted-foreground" />
            </div>
            <p className="font-medium">Nothing is shared with you yet</p>
            <p className="max-w-sm text-sm text-balance text-muted-foreground">
              Threads that people outside your spaces share with you appear here. They arrive as
              invite links; open one to join the thread.
            </p>
          </div>
        )}
        {!!shared.data?.length && (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Shared threads">
            {shared.data.map((thread) => (
              <li key={thread.id}>
                <Link
                  to="/t/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="truncate font-medium">{thread.title}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {/* A space already named after its org's person needs no org after it. */}
                      {thread.spaceName === `${thread.orgName}'s space`
                        ? thread.spaceName
                        : `${thread.spaceName} · ${thread.orgName}`}
                    </span>
                  </div>
                  <Until
                    iso={thread.accessUntil}
                    className="shrink-0 text-xs text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
