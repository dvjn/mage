// An artifact's page: its newest version or an older one, read-only, in a frame on the artifacts'
// origin through a link the server signs for this reader and theme. The frame is reloaded when a
// new version is published; the link is asked for again before it expires, which the frame picks up
// at its next reload so a page in use is not reset. Above the frame, what the artifact is, its
// space, the thread it was made in where the reader can read it, which version is shown, its
// versions to pick from, who may open it and deleting it, as far as the server lets the reader.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { HistoryIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { ArtifactDetail, ArtifactEvent, ArtifactTheme } from "@/shared/artifacts.ts";
import { artifactEventSchema } from "@/shared/artifacts.ts";
import { DeleteArtifact } from "@/web/artifacts/delete-artifact";
import { artifactQuery, artifactViewQuery } from "@/web/artifacts/queries";
import { ShareArtifact } from "@/web/artifacts/share-artifact";
import { Time } from "@/web/components/time";
import { Button } from "@/web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { Spinner } from "@/web/components/ui/spinner";
import { WithTooltip } from "@/web/components/with-tooltip";
import { tabOrg } from "@/web/lib/org-tab";
import { NotFound } from "@/web/shell/not-found";
import { PageHeader } from "@/web/shell/page-header";
import { useTheme } from "@/web/shell/theme-provider";

const route = getRouteApi("/_app/artifacts/$artifactId");

// The theme the app shows now, which a page follows.
function useShownTheme(): ArtifactTheme {
  const { theme } = useTheme();
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setDark(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return theme === "system" ? (dark ? "dark" : "light") : theme;
}

// Tells of new versions, sharing changes and deletion of the artifact while it is open.
function useArtifactEvents(id: string, onEvent: (event: ArtifactEvent) => void) {
  useEffect(() => {
    const org = tabOrg();
    const source = new EventSource(`/api/v1/artifacts/${id}/events${org ? `?org=${org}` : ""}`);
    const listen = (message: MessageEvent<string>) => {
      const event = artifactEventSchema.safeParse(JSON.parse(message.data));
      if (event.success) onEvent(event.data);
    };
    for (const type of ["published", "sharing", "deleted"]) source.addEventListener(type, listen);
    source.addEventListener("access-ended", () => onEvent({ type: "deleted", artifactId: id }));
    return () => source.close();
  }, [id, onEvent]);
}

// The versions to pick from, newest first, each with its label and when it was published.
function VersionHistory({
  artifact,
  viewing,
  onPick,
}: {
  artifact: ArtifactDetail;
  viewing: number;
  onPick: (version: number) => void;
}) {
  return (
    <DropdownMenu>
      <WithTooltip label="Version history">
        <DropdownMenuTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label="Version history" />}
        >
          <HistoryIcon />
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Version history</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(viewing)}
            onValueChange={(next: string) => onPick(Number(next))}
          >
            {artifact.versions.map((one) => (
              <DropdownMenuRadioItem
                key={one.version}
                value={String(one.version)}
                closeOnClick
                className="py-1.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    Version {one.version}
                    {one.version === artifact.version && (
                      <span className="text-xs text-muted-foreground">Latest</span>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {one.label && `${one.label} · `}
                    {one.thread && `${one.thread.title ?? "Untitled"} · `}
                    <Time iso={one.createdAt} />
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactPage() {
  const { artifactId } = route.useParams();
  const { version } = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();
  const artifact = useQuery(artifactQuery(artifactId));
  const theme = useShownTheme();
  const link = useQuery({
    ...artifactViewQuery(artifactId, version, theme),
    enabled: artifact.isSuccess,
    // Asked for again a few minutes before it lapses.
    refetchInterval: 55 * 60 * 1000,
  });

  // The frame's address: taken from the link when the page is opened and when it must reload, and
  // otherwise kept so a refreshed link does not reset the page.
  const [src, setSrc] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [loadedFor, setLoadedFor] = useState("");
  const [shownFor, setShownFor] = useState("");
  const fresh = link.data?.url ?? null;
  // Another version or theme is another link, which has no data until it is made.
  const wanted = `${version ?? "latest"}:${theme}:${reloads}`;
  useEffect(() => {
    if (fresh && (src === null || loadedFor !== wanted)) {
      setSrc(fresh);
      setLoadedFor(wanted);
    }
  }, [fresh, src, loadedFor, wanted]);

  const [followed, setFollowed] = useState<ArtifactEvent | null>(null);
  useArtifactEvents(artifactId, (event) => {
    setFollowed(event);
    void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    if (event.type === "published" && version === undefined) {
      void link.refetch().then(() => setReloads((count) => count + 1));
    }
  });

  if (artifact.isError || followed?.type === "deleted") {
    return <NotFound what="artifact" />;
  }
  const detail = artifact.data;
  const latest = detail?.version;
  const viewing = version ?? latest;
  const older = detail && viewing !== undefined && viewing !== latest;
  const pick = (next: number) =>
    void navigate({ search: next === latest ? {} : { version: next }, replace: true });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumbs={[
          ...(detail?.space
            ? [
                {
                  label: detail.space.name,
                  link: { to: "/s/$spaceId" as const, params: { spaceId: detail.space.id } },
                },
              ]
            : []),
          { label: detail?.title ?? "" },
        ]}
      >
        {detail && viewing !== undefined && (
          <>
            <VersionHistory artifact={detail} viewing={viewing} onPick={pick} />
            <ShareArtifact artifact={detail} />
            <DeleteArtifact artifact={detail} />
          </>
        )}
      </PageHeader>
      {older && detail && (
        <div
          role="region"
          aria-label="Older version"
          className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2"
        >
          <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className="flex-1 text-sm text-muted-foreground">
            Version {viewing} of {latest} · read-only
          </span>
          <Button size="sm" variant="outline" onClick={() => pick(detail.version)}>
            Back to latest
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 border-t bg-background">
        {link.isError ? (
          <div
            role="alert"
            className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center"
          >
            <TriangleAlertIcon className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Can't show this artifact</p>
            <p className="max-w-sm text-sm text-muted-foreground">{link.error.message}</p>
          </div>
        ) : (
          <>
            {src && (
              <iframe
                title={detail?.title ?? "Artifact"}
                src={src}
                // The page's origin is not the app's, so the app's session never reaches it; it
                // keeps its own storage and loads its own files.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
                onLoad={() => setShownFor(src)}
                className="block size-full bg-background"
              />
            )}
            {shownFor !== src && (
              <div className="absolute inset-0 flex items-center justify-center bg-background">
                <Spinner className="text-muted-foreground" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
