// One entry of a turn, drawn again only when its own rows or what it is given change, so a new
// event of a thread renders the rows it touched and not the whole transcript.

import { memo } from "react";

import type { ShownRow } from "@/shared/threads/rows.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import { ArtifactCard } from "@/web/artifacts/artifact-card";
import type { TranscriptEntry } from "@/web/threads/transcript/entries";
import { NoticeMessages } from "@/web/threads/transcript/notice-message";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { ToolCall } from "@/web/threads/transcript/tool-call";
import { ToolGroup } from "@/web/threads/transcript/tool-group";
import { TranscriptItem } from "@/web/threads/transcript/transcript-item";

interface Props {
  entry: TranscriptEntry;
  tools: ToolDefinition[] | undefined;
  actionsFor: (row: ShownRow) => RowActions;
  // Whether a calls entry's calls are open, and the open rows of the notices it shows.
  open: boolean;
  opened: ReadonlySet<string> | undefined;
  onOpenChange: (ids: string[], open: boolean) => void;
}

const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

// Entries are made anew with each event; two are the same when they hold the same rows.
function sameEntry(a: TranscriptEntry, b: TranscriptEntry) {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case "row":
      return a.row === (b as typeof a).row && a.endsTurn === (b as typeof a).endsTurn;
    case "calls": {
      const other = b as typeof a;
      return same(a.rows, other.rows) && same(a.calls, other.calls) && a.turn === other.turn;
    }
    case "subagent": {
      const other = b as typeof a;
      return (
        a.row === other.row &&
        a.subagent.threadId === other.subagent.threadId &&
        a.subagent.name === other.subagent.name
      );
    }
    case "notices":
      return same(a.rows, (b as typeof a).rows);
    case "artifacts": {
      const other = b as typeof a;
      return (
        a.items.length === other.items.length &&
        a.items.every((item, index) =>
          Object.entries(item).every(
            ([key, value]) =>
              value === (other.items[index] as unknown as Record<string, unknown>)[key],
          ),
        )
      );
    }
  }
}

export const EntryView = memo(
  function EntryView({ entry, tools, actionsFor, open, opened, onOpenChange }: Props) {
    switch (entry.kind) {
      case "calls":
        return (
          <ToolGroup
            rows={entry.rows}
            calls={entry.calls}
            turn={entry.turn}
            tools={tools ?? []}
            open={open}
            onOpenChange={(next) =>
              onOpenChange(
                entry.calls.map((call) => call.id),
                next,
              )
            }
          />
        );
      case "notices":
        return (
          <NoticeMessages
            rows={entry.rows}
            opened={opened ?? new Set()}
            onOpenChange={onOpenChange}
          />
        );
      case "artifacts":
        return (
          <div className="flex flex-col gap-1.5">
            {entry.items.map((item) => (
              <ArtifactCard key={item.id} {...item} latest />
            ))}
          </div>
        );
      case "subagent": {
        const actions = actionsFor(entry.row);
        return (
          <ToolCall
            row={entry.row}
            definition={tools?.find((tool) => tool.name === entry.row.toolId)}
            turn={{ continued: false, model: null }}
            subagent={entry.subagent.name}
            answer={actions.answer}
          />
        );
      }
      case "row":
        return (
          <TranscriptItem
            row={entry.row}
            tools={tools}
            actions={actionsFor(entry.row)}
            endsTurn={entry.endsTurn}
          />
        );
    }
  },
  (a, b) =>
    sameEntry(a.entry, b.entry) &&
    a.tools === b.tools &&
    a.actionsFor === b.actionsFor &&
    a.open === b.open &&
    a.opened === b.opened &&
    a.onOpenChange === b.onOpenChange,
);
