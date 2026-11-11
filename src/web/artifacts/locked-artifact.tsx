// An artifact not shared with the reader, as a row says so: a tile, its title and the reason. The
// card in a transcript and the thread's list of artifacts both show it.

import { EyeOffIcon } from "lucide-react";

export function LockedArtifact({ title, tile = "size-9" }: { title: string; tile?: string }) {
  return (
    <>
      <span
        className={`flex ${tile} shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground`}
      >
        <EyeOffIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-muted-foreground">{title}</span>
        <span className="truncate text-xs text-muted-foreground">Not shared with you</span>
      </span>
    </>
  );
}
