// An artifact's call in the transcript as a card: its icon, title, description and version, with a
// way to open it that the whole card answers to. A published or updated artifact is read as it is
// now, so the description and icon are the newest; one since deleted shows as such, and one not
// shared with the reader is locked, with no way in. In a thread, a member who may change it can
// give the thread's guests access from the card.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";

import { createContext, useContext } from "react";

import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";

import { ArtifactIcon } from "@/web/artifacts/artifact-icon";
import { LockedArtifact } from "@/web/artifacts/locked-artifact";
import { artifactQuery, NotSharedError, threadArtifactsQuery } from "@/web/artifacts/queries";
import { Button, buttonVariants } from "@/web/components/ui/button";

// The thread the cards are shown in, none elsewhere.
export const ArtifactThreadContext = createContext<string | null>(null);

// The card's own line about the thread's guests, and the button that shares with them.
function useGuestAccess(id: string, threadId: string | null) {
  const queryClient = useQueryClient();
  const list = useQuery({ ...threadArtifactsQuery(threadId ?? ""), enabled: !!threadId });
  const share = useMutation({
    mutationFn: async () => {
      if (!threadId) return;
      const res = await apiClient.v1.artifacts[":id"].guests.$put({
        param: { id },
        json: { threadId, shared: true },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["artifacts"] }),
  });
  return { guests: list.data?.find((item) => item.id === id)?.guests ?? null, share };
}

export function ArtifactCard({
  id,
  version,
  title,
  className,
  latest,
}: {
  id: string;
  version: number;
  // The name as of the call, for when the artifact is gone.
  title: string;
  className?: string;
  // Shows the newest version, and nothing once the artifact is gone.
  latest?: boolean;
}) {
  const artifact = useQuery(artifactQuery(id));
  const { guests, share } = useGuestAccess(id, useContext(ArtifactThreadContext));
  const locked = artifact.error instanceof NotSharedError;
  const gone = artifact.isError && !locked;
  if (latest && gone) return null;
  const shown = latest ? (artifact.data?.version ?? version) : version;
  return (
    <div
      data-testid="artifact-card"
      className={cn(
        "relative flex items-center gap-3 rounded-lg border bg-card p-2.5 transition-colors",
        !gone && !locked && "hover:bg-muted/50",
        className,
      )}
    >
      {locked ? (
        <LockedArtifact title={title} />
      ) : (
        <>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
            <ArtifactIcon icon={artifact.data?.icon ?? "page"} className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
              <span className={cn("truncate font-medium", gone && "text-muted-foreground")}>
                {artifact.data?.title ?? title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">v{shown}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {gone ? "Deleted" : artifact.data?.description}
              {guests?.shared && !gone && " · Guests can open"}
            </span>
          </div>
        </>
      )}
      {guests?.canChange && !guests.shared && !locked && !gone && (
        <Button
          size="sm"
          variant="ghost"
          // Above the card's own link.
          className="relative z-10"
          disabled={share.isPending}
          onClick={() => share.mutate()}
        >
          Give guests access
        </Button>
      )}
      {!gone && !locked && (
        <Link
          to="/artifacts/$artifactId"
          params={{ artifactId: id }}
          // The whole card opens it.
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "after:absolute after:inset-0 after:rounded-lg",
          )}
        >
          Open
        </Link>
      )}
    </div>
  );
}
