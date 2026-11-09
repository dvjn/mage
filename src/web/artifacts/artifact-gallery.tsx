// The artifacts the person can open across their org, newest change first, as cards that each open
// the artifact, narrowed by space and by who may open them, a page after another.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { FileTextIcon } from "lucide-react";

import { artifactSharingSchema, type ArtifactListItem } from "@/shared/artifacts.ts";
import { ArtifactIcon } from "@/web/artifacts/artifact-icon";
import { artifactPages } from "@/web/artifacts/queries";
import { SHARING_LEVELS } from "@/web/artifacts/share-artifact";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/web/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { PageHeader } from "@/web/shell/page-header";
import { spacesQuery } from "@/web/spaces/queries";

const route = getRouteApi("/_app/artifacts");

// The select's value for no filter.
const ALL = "all";

function GalleryCard({ artifact }: { artifact: ArtifactListItem }) {
  const sharing = SHARING_LEVELS[artifact.sharing];
  const SharingIcon = sharing.icon;
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
          <SharingIcon aria-label={sharing.label} className="size-3.5 shrink-0" />
        </span>
      </div>
    </div>
  );
}

export function ArtifactGalleryPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const spaces = useQuery(spacesQuery);
  const pages = useInfiniteQuery(artifactPages(search));
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const spaceName = spaces.data?.find((space) => space.id === search.space)?.name;
  return (
    <>
      <PageHeader crumbs={[{ label: "Artifacts" }]} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 pb-12">
        <div className="flex flex-wrap gap-2">
          <Select
            value={search.space ?? ALL}
            onValueChange={(value) =>
              void navigate({
                search: { ...search, space: value && value !== ALL ? value : undefined },
                replace: true,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Space" className="w-44">
              <SelectValue>{spaceName ?? "All spaces"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All spaces</SelectItem>
              {spaces.data?.map((space) => (
                <SelectItem key={space.id} value={space.id}>
                  {space.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.sharing ?? ALL}
            onValueChange={(value) => {
              const parsed = artifactSharingSchema.safeParse(value);
              void navigate({
                search: { ...search, sharing: parsed.success ? parsed.data : undefined },
                replace: true,
              });
            }}
          >
            <SelectTrigger size="sm" aria-label="Sharing" className="w-44">
              <SelectValue>
                {search.sharing ? SHARING_LEVELS[search.sharing].label : "Any sharing"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any sharing</SelectItem>
              {artifactSharingSchema.options.map((level) => (
                <SelectItem key={level} value={level}>
                  {SHARING_LEVELS[level].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {pages.isPending ? null : items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon />
              </EmptyMedia>
              <EmptyTitle>No artifacts yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((artifact) => (
              <GalleryCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
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
