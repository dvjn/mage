// The artifacts the person can open across their org, newest change first, as cards that each open
// the artifact, grouped by when they were last updated, a page after another.

import { EmptyState } from "@/web/components/page-states";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShapesIcon } from "lucide-react";

import type { ArtifactListItem } from "@/shared/artifacts.ts";
import { ArtifactIcon } from "@/web/artifacts/artifact-icon";
import { groupByUpdate } from "@/web/artifacts/group-by-update";
import { artifactPages } from "@/web/artifacts/queries";
import { SharingIndicator } from "@/web/artifacts/share-artifact";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { PageHeader } from "@/web/shell/page-header";

function GalleryCard({ artifact }: { artifact: ArtifactListItem }) {
  return (
    <div
      data-testid="artifact-card"
      className="relative flex flex-col gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
          <ArtifactIcon icon={artifact.icon} className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            to="/artifacts/$artifactId"
            params={{ artifactId: artifact.id }}
            // The whole card opens it.
            className="truncate text-sm font-medium after:absolute after:inset-0 after:rounded-lg"
          >
            {artifact.title}
          </Link>
          <span className="truncate text-xs text-muted-foreground">{artifact.description}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0">
          v{artifact.version} · updated <Time iso={artifact.updatedAt} />
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1">
          <span className="truncate">{artifact.space.name}</span>
          <SharingIndicator sharing={artifact.sharing} />
        </span>
      </div>
    </div>
  );
}

export function ArtifactGalleryPage() {
  const pages = useInfiniteQuery(artifactPages);
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageHeader crumbs={[{ label: "Artifacts" }]} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 pb-12">
        {pages.isPending ? null : items.length === 0 ? (
          <EmptyState icon={<ShapesIcon />} title="No artifacts yet" />
        ) : (
          groupByUpdate(items).map((group) => (
            <section key={group.heading} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">{group.heading}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map((artifact) => (
                  <GalleryCard key={artifact.id} artifact={artifact} />
                ))}
              </div>
            </section>
          ))
        )}
        {pages.hasNextPage && (
          <Button
            variant="outline"
            className="self-center"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </div>
    </>
  );
}
