// What can be done from a message in a thread's history, as the page wires it, and the quiet row
// of icon buttons under each message that does it: the versions of a message written again, then
// copy, retry, retry with a model and effort picked with the composer's own pickers, edit, restore
// from here, fork and ask aside; once there is a side question about the message, it stays in view
// at the end of the row instead. Which of them a reader sees is the server's to say; the actions
// show on hover, on focus within the message, and always where nothing hovers.

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  RefreshCcwDotIcon,
  RefreshCcwIcon,
  SplitIcon,
  Undo2Icon,
} from "lucide-react";
import { cn } from "cn";
import { createContext, useContext, useState } from "react";

import type { ModelSummary } from "@/shared/models.ts";
import type { ThreadDefaults } from "@/shared/threads/detail.ts";
import type { AskedModel } from "@/shared/threads/history.ts";
import type { RowAction, RowVersions } from "@/shared/threads/rows.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { CopyButton } from "@/web/components/copy-button";
import { WithTooltip } from "@/web/components/with-tooltip";
import { Button } from "@/web/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { ThreadPickers } from "@/web/models/thread-pickers";
import { AsideButton, AsidesContext } from "@/web/threads/transcript/aside-thread";

// What the composer's pickers show for the thread, and the model it replies with now.
export interface Pickers {
  models: ModelSummary[];
  loading: boolean;
  model: string | null;
  effort: Effort | null;
  defaults: ThreadDefaults | undefined;
  used: { ref: string; name: string; effort: Effort | null } | null | undefined;
  replying: string | null;
}

export interface RowHistory {
  // Writes the reply again, with the thread's model or the one asked.
  retry(rowId: string, asked?: AskedModel): void;
  restore(rowId: string): void;
  fork(rowId: string): void;
  // Opens the branch that shows a version.
  version(branchId: string): void;
  pickers: Pickers;
}

export const RowHistoryContext = createContext<RowHistory | null>(null);

export function useRowHistory() {
  return useContext(RowHistoryContext);
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <WithTooltip label={label}>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </WithTooltip>
  );
}

// Which of a message's versions shows, with a way to the one before and after.
export function VersionSwitcher({ versions }: { versions: RowVersions }) {
  const history = useRowHistory();
  const { at, branches } = versions;
  const go = (index: number) => {
    const branch = branches[index];
    if (branch) history?.version(branch);
  };
  return (
    <div
      role="group"
      aria-label="Versions"
      className="flex items-center text-xs text-muted-foreground tabular-nums"
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous version"
        disabled={at === 0}
        onClick={() => go(at - 1)}
      >
        <ChevronLeftIcon />
      </Button>
      <span>
        {at + 1}/{branches.length}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next version"
        disabled={at === branches.length - 1}
        onClick={() => go(at + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

// The model and effort to write the reply again with, from what the thread replies with now.
function RetryWith({ rowId, history }: { rowId: string; history: RowHistory }) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const { pickers } = history;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setModel(pickers.model);
        setEffort(pickers.effort);
      }}
    >
      <WithTooltip label="Retry with">
        <PopoverTrigger
          render={
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Retry with">
              <RefreshCcwDotIcon />
            </Button>
          }
        />
      </WithTooltip>
      <PopoverContent align="start" className="w-auto p-2">
        <div role="group" aria-label="Retry with" className="flex flex-wrap items-center gap-1">
          <ThreadPickers
            models={pickers.models}
            loading={pickers.loading}
            model={model}
            effort={effort}
            defaults={pickers.defaults}
            used={pickers.used}
            onModel={setModel}
            onEffort={setEffort}
          />
          <Button
            type="button"
            size="sm"
            className="ml-1"
            onClick={() => {
              const ref = model ?? pickers.replying;
              history.retry(rowId, ref ? { model: ref, effort } : undefined);
              setOpen(false);
            }}
          >
            Retry
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function RowToolbar({
  rowId,
  text,
  can = [],
  versions,
  onEdit,
}: {
  rowId: string;
  // What copying it copies.
  text: string;
  can?: readonly RowAction[];
  versions?: RowVersions;
  onEdit?: () => void;
}) {
  const history = useRowHistory();
  const may = (action: RowAction) => !!history && can.includes(action);
  const asides = useContext(AsidesContext);
  const asked = (asides?.byRow.get(rowId)?.length ?? 0) > 0;
  const hover = cn(
    "opacity-0 transition-opacity duration-150 has-[[aria-expanded=true]]:opacity-100",
    "group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
  );
  return (
    <div className="-mx-1.5 -mb-1 flex h-6 items-center gap-0.5">
      {versions && <VersionSwitcher versions={versions} />}
      <div
        role="toolbar"
        aria-label="Message actions"
        className="flex flex-1 items-center gap-0.5 text-muted-foreground [&_svg]:size-3.5!"
      >
        <div className={cn("flex items-center gap-0.5", hover)}>
          {text && <CopyButton label="Copy" value={text} />}
          {may("retry") && (
            <>
              <IconAction label="Retry" onClick={() => history!.retry(rowId)}>
                <RefreshCcwIcon />
              </IconAction>
              <RetryWith rowId={rowId} history={history!} />
            </>
          )}
          {may("edit") && onEdit && (
            <IconAction label="Edit" onClick={onEdit}>
              <PencilIcon />
            </IconAction>
          )}
          {may("restore") && (
            <IconAction label="Restore from here" onClick={() => history!.restore(rowId)}>
              <Undo2Icon />
            </IconAction>
          )}
          {may("fork") && (
            <IconAction label="Fork into new thread" onClick={() => history!.fork(rowId)}>
              <SplitIcon />
            </IconAction>
          )}
          {may("aside") && <AsideButton rowId={rowId} fresh />}
        </div>
        {asked && <AsideButton rowId={rowId} fresh={false} className="ml-auto" />}
      </div>
    </div>
  );
}
