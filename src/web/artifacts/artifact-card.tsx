// An artifact's call in the transcript as a card: its icon, title, description and version, with a
// way to open it that the whole card answers to. A published or updated artifact is read as it is
// now, so the description and icon are the newest; one since deleted shows as such.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";

import { ArtifactIcon } from "@/web/artifacts/artifact-icon";
import { artifactQuery } from "@/web/artifacts/queries";
import { buttonVariants } from "@/web/components/ui/button";

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
  const gone = artifact.isError;
  if (latest && gone) return null;
  const shown = latest ? (artifact.data?.version ?? version) : version;
  return (
    <div
      data-testid="artifact-card"
      className={cn(
        "relative flex items-center gap-3 rounded-lg border bg-card p-2.5 transition-colors",
        !gone && "hover:bg-muted/50",
        className,
      )}
    >
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
        </span>
      </div>
      {!gone && (
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
