// Where the thread was compacted: a line across it naming who compacted it, which opens the summary
// the agent reads from then on in place of what came before.

import { ChevronDownIcon } from "lucide-react";

import type { CompactionRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";

export function CompactionDivider({ row }: { row: CompactionRow }) {
  const by = row.by ? row.by.name : "the agent";
  return (
    <Collapsible className="flex flex-col gap-2" role="group" aria-label="Compaction">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <CollapsibleTrigger className="group flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground">
          Compacted by {by}
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 transition-transform group-data-[panel-open]:rotate-180"
          />
        </CollapsibleTrigger>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      <CollapsibleContent className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        {row.focus && <p className="mb-2 text-xs text-muted-foreground">Focus: {row.focus}</p>}
        <MessageResponse>{row.summary}</MessageResponse>
      </CollapsibleContent>
    </Collapsible>
  );
}
