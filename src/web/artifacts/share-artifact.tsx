// Who may open an artifact, on one surface opened from the Share button in its header: a dialog,
// or a sheet from the bottom on a phone. The levels are a list to pick from, each saying who it
// reaches; one the server does not offer the reader is left out, and for one who may not share
// at all they are all shown closed, with the reason said once. Below, the link to copy: the public
// one while it is public, else the artifact's page in the app.

import { Building2Icon, GlobeIcon, MessageSquareIcon, Share2Icon } from "lucide-react";
import type * as React from "react";
import { useId } from "react";

import type { ArtifactDetail, ArtifactSharing } from "@/shared/artifacts.ts";
import { artifactSharingSchema } from "@/shared/artifacts.ts";
import { useSetSharing } from "@/web/artifacts/mutations";
import { CopyButton } from "@/web/components/copy-button";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/web/components/ui/dialog";
import { FieldError, FieldLabel } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/web/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/web/components/ui/sheet";
import { useIsMobile } from "@/web/hooks/use-mobile";

export const SHARING_LEVELS: Record<
  ArtifactSharing,
  { label: string; reach: string; icon: React.ComponentType<{ className?: string }> }
> = {
  thread: { label: "Thread", reach: "People who can read the thread", icon: MessageSquareIcon },
  org: { label: "Organization", reach: "Everyone in the organization", icon: Building2Icon },
  public: { label: "Public", reach: "Anyone with the link", icon: GlobeIcon },
};

function ShareBody({ artifact }: { artifact: ArtifactDetail }) {
  const id = useId();
  const setSharing = useSetSharing(artifact.id);
  const blocked = new Map(artifact.sharingBlocked.map((one) => [one.level, one.reason]));
  const reason = [...blocked.values()][0];
  const levels = artifactSharingSchema.options.filter(
    (level) => blocked.has(level) || artifact.sharingLevels.includes(level),
  );
  const link = artifact.publicUrl ?? `${window.location.origin}/artifacts/${artifact.id}`;
  return (
    <div className="flex flex-col gap-5">
      {reason && <p className="text-sm text-muted-foreground">{reason}.</p>}
      <RadioGroup
        aria-label="Who can open it"
        value={artifact.sharing}
        disabled={setSharing.isPending}
        onValueChange={(next) => {
          const parsed = artifactSharingSchema.safeParse(next);
          if (parsed.success && parsed.data !== artifact.sharing) setSharing.mutate(parsed.data);
        }}
        className="gap-0 overflow-hidden rounded-lg border"
      >
        {levels.map((level) => {
          const { label, reach, icon: Icon } = SHARING_LEVELS[level];
          return (
            <label
              key={level}
              className="flex cursor-pointer items-start gap-3 border-b px-3 py-2.5 last:border-b-0 has-data-checked:bg-muted/50 has-data-disabled:cursor-not-allowed"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={`text-sm font-medium ${blocked.has(level) ? "text-muted-foreground" : ""}`}
                >
                  {label}
                </span>
                <span className="text-xs text-muted-foreground">{reach}</span>
              </span>
              <RadioGroupItem
                value={level}
                aria-label={label}
                disabled={blocked.has(level)}
                className="mt-0.5"
              />
            </label>
          );
        })}
      </RadioGroup>
      <FieldError>{setSharing.error?.message}</FieldError>
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor={id}>Link</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id={id}
            value={link}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <InputGroupAddon align="inline-end">
            <CopyButton label="Copy link" value={link} />
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
}

export function ShareArtifact({ artifact }: { artifact: ArtifactDetail }) {
  const mobile = useIsMobile();
  const trigger = (
    <>
      <Share2Icon />
      Share
    </>
  );
  const description = "Choose who can open this artifact.";
  if (mobile) {
    return (
      <Sheet>
        <SheetTrigger render={<Button size="sm" variant="outline" />}>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
          <SheetHeader className="pb-0">
            <SheetTitle>Share artifact</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <ShareBody artifact={artifact} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share artifact</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ShareBody artifact={artifact} />
      </DialogContent>
    </Dialog>
  );
}
