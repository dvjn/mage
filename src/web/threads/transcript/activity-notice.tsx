// Notifications reuse the right-aligned chat bubble. Their dashed outline distinguishes received activity
// from human messages; the avatar's card tells of the source without adding metadata to the conversation.
import { ChevronDownIcon } from "lucide-react";
import { Children, type ReactNode, useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { type Source, SourceCard } from "@/web/threads/transcript/source-card";

export function ActivityNotice({
  rowId,
  label = "Notification",
  source,
  title,
  open,
  onOpenChange,
  actions,
  status,
  children,
}: {
  rowId?: string;
  label?: string;
  source: Source;
  // One line saying what came in, as a tool call's line does.
  title: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actions?: ReactNode;
  status?: string;
  // What opening shows; with none, the title is all there is.
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = open ?? expanded;
  const more = Children.toArray(children).some((child) => child !== "");
  return (
    <TranscriptRowFrame
      rowId={rowId}
      human
      outlined
      avatar={<SourceCard source={source} />}
      author={source.name}
      label={label}
      actions={actions}
    >
      <Collapsible
        open={isOpen}
        onOpenChange={(next) => {
          setExpanded(next);
          onOpenChange?.(next);
        }}
        role={status ? "status" : undefined}
        aria-label={status}
        className="min-w-0 text-sm"
      >
        <div className="flex min-w-0 items-center justify-end gap-1">
          <span className="min-w-0 truncate">{title}</span>
          {more && (
            <CollapsibleTrigger
              aria-label={isOpen ? "Hide details" : "Show details"}
              className="group/notice -my-0.5 -mr-1 shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 transition-transform group-data-[panel-open]/notice:rotate-180"
              />
            </CollapsibleTrigger>
          )}
        </div>
        {more && (
          <CollapsibleContent className="mt-2 flex flex-col gap-2 [overflow-wrap:anywhere]">
            {children}
          </CollapsibleContent>
        )}
      </Collapsible>
    </TranscriptRowFrame>
  );
}
