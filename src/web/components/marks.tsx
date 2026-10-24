// Marks for models and the hosts they come through. A model shows its maker's mark, in the maker's
// colour, or in the foreground colour where the maker's own is black on light and white on dark; a
// bot in muted grey for a model no one can tell the maker of. A host shows its own mark, the generic
// server mark when it has none, or a named server's initial. A model's tile carries its host as a
// badge on its top-left corner: quiet, the host's mark in muted grey, where the host is the maker's
// own API, and in the host's colour on a disc elsewhere. Screen readers leave the marks out, so what
// they stand for is said beside them or in the tile's label.

import { cn } from "cn";
import { BotIcon, ServerIcon } from "lucide-react";

import { type HostId, hostOf } from "@/shared/hosts.ts";
import { type MakerId, MAKERS } from "@/shared/makers.ts";
import { MARKS } from "@/web/icons/marks";

// Marks drawn in one colour that is the brand's, rather than black or white.
const TINTS: Record<string, string> = { groq: "text-[#F55036]" };

// A vendored mark by name, in colour where it has one and colour is asked for.
export function Mark({
  name,
  color = true,
  className,
}: {
  name: string;
  color?: boolean;
  className?: string;
}) {
  const mark = MARKS[name];
  if (!mark) return null;
  return (
    <svg
      viewBox={mark.viewBox ?? "0 0 24 24"}
      aria-hidden
      className={cn("size-4 shrink-0", color && TINTS[name], className)}
      dangerouslySetInnerHTML={{ __html: (color && mark.color) || mark.mono }}
    />
  );
}

// The mark of who makes a model, in colour; a bot when no one can tell.
export function MakerMark({ maker, className }: { maker: MakerId | null; className?: string }) {
  if (!maker) {
    return (
      <BotIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
    );
  }
  return <Mark name={MAKERS[maker].mark} className={className} />;
}

// What a host mark stands for: the host, and the name of the connection when it is a server people
// named, whose initial stands in for a mark.
export interface HostRef {
  host: HostId | null;
  label?: string | null | undefined;
}

// The mark of a host, in colour unless asked for its monochrome one.
export function HostMark({
  host,
  label,
  mono,
  className,
}: HostRef & { mono?: boolean; className?: string }) {
  const mark = host ? hostOf(host).mark : undefined;
  if (mark) return <Mark name={mark} color={!mono} className={className} />;
  if (host && label && hostOf(host).group === "self-hosted") {
    return (
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full bg-muted-foreground text-[0.6rem] leading-none font-semibold text-background uppercase",
          className,
        )}
      >
        {label.trim().charAt(0)}
      </span>
    );
  }
  return (
    <ServerIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />
  );
}

// The name people gave a connection, from how people know it, as "Lab box" from
// "OpenAI-compatible · Lab box"; null when it has none.
export function givenName(connectionLabel: string | null | undefined) {
  const at = connectionLabel?.indexOf(" · ") ?? -1;
  return at >= 0 ? connectionLabel!.slice(at + 3) : null;
}

// Whether the host is the maker's own API, whose badge stays quiet.
export function makerOwnHost(host: HostId, maker: MakerId | null) {
  const { firstParty, maker: hostMaker } = hostOf(host);
  return !!firstParty && !!maker && hostMaker === maker;
}

// How people know a model and where it comes from, as "Claude Opus · Amazon Bedrock".
export function modelLabel(name: string, via: string | null | undefined) {
  return via ? `${name} · ${via}` : name;
}

// A model's tile: its maker's mark, with its host as a badge on the top-left corner, ringed in the
// colour around the tile, given as `disc`. What else goes on the tile, such as a status on another
// corner, is given as its children.
export function ModelTile({
  maker,
  host,
  connection,
  disc,
  className,
  children,
}: {
  maker: MakerId | null;
  host: HostId | null;
  // How people know the connection, for a named server's initial.
  connection?: string | null;
  disc: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const quiet = host && makerOwnHost(host, maker);
  return (
    <span
      data-maker={maker ?? undefined}
      className={cn(
        "relative order-first grid size-8 shrink-0 place-items-center overflow-visible! rounded-lg bg-muted",
        className,
      )}
    >
      <MakerMark maker={maker} className="size-4" />
      {host && (
        <span
          aria-hidden
          data-host={host}
          className={cn("absolute -top-1 -left-1 grid place-items-center rounded-full p-px", disc)}
        >
          <span
            className={cn(
              "grid size-3.5 place-items-center rounded-full",
              quiet ? "text-muted-foreground" : "bg-background ring-1 ring-border",
            )}
          >
            <HostMark
              host={host}
              label={givenName(connection)}
              mono={!!quiet}
              className="size-2.5 text-[0.45rem]"
            />
          </span>
        </span>
      )}
      {children}
    </span>
  );
}
