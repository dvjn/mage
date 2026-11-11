// A thread's artifacts in one place: a header button with how many there are, opening a list of
// them, newest update first, each linking to its page and saying who may open it; one not shared with the reader is locked. It lists the ones
// this thread used. The list is read again whenever the count of the thread's finished artifact
// calls changes.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShapesIcon } from "lucide-react";
import { useEffect } from "react";

import { ARTIFACT_TOOLS } from "@/shared/artifacts.ts";
import type { ShownRow } from "@/shared/threads/rows.ts";
import { ArtifactIcon } from "@/web/artifacts/artifact-icon";
import { LockedArtifact } from "@/web/artifacts/locked-artifact";
import { threadArtifactsQuery } from "@/web/artifacts/queries";
import { SharingIndicator } from "@/web/artifacts/share-artifact";
import { Button } from "@/web/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/web/components/ui/popover";
import { Time } from "@/web/components/time";
import { WithTooltip } from "@/web/components/with-tooltip";

const CHANGING = new Set<string>([ARTIFACT_TOOLS.publish, ARTIFACT_TOOLS.update]);

export function ThreadArtifacts({
  threadId,
  rows,
}: {
  threadId: string;
  rows: readonly ShownRow[];
}) {
  const queryClient = useQueryClient();
  const artifacts = useQuery(threadArtifactsQuery(threadId));
  const finished = rows.filter(
    (row) => row.kind === "tool" && row.state === "ran" && CHANGING.has(row.toolId),
  ).length;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: threadArtifactsQuery(threadId).queryKey });
  }, [queryClient, threadId, finished]);
  const list = [...(artifacts.data ?? [])].toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  if (list.length === 0) return null;
  return (
    <Popover>
      <WithTooltip label="Artifacts">
        <PopoverTrigger
          render={
            <Button size="sm" variant="ghost" aria-label="Artifacts" className="tabular-nums" />
          }
        >
          <ShapesIcon />
          {list.length}
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent align="end" className="w-80 gap-0 p-1">
        <PopoverHeader className="px-2 pt-1.5 pb-1">
          <PopoverTitle className="text-xs font-medium text-muted-foreground">
            Artifacts
          </PopoverTitle>
        </PopoverHeader>
        <ul className="flex max-h-96 flex-col overflow-y-auto">
          {list.map((artifact) => {
            if (artifact.locked) {
              return (
                <li key={artifact.id} className="flex items-center gap-3 px-2 py-1.5">
                  <LockedArtifact title={artifact.title} tile="size-8" />
                </li>
              );
            }
            return (
              <li key={artifact.id}>
                <Link
                  to="/artifacts/$artifactId"
                  params={{ artifactId: artifact.id }}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
                    <ArtifactIcon icon={artifact.icon} className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{artifact.title}</span>
                    <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                      v{artifact.version} · <Time iso={artifact.updatedAt} /> ·
                      <SharingIndicator sharing={artifact.sharing} />
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
