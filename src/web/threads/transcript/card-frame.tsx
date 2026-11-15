// The frame every card in the transcript shares, tool calls and notices alike: an outline
// with a header row of a kind icon, a title, an optional status or meta chip and the time, and a
// body that is collapsed unless the card is told to open, with a chevron only where there is one.

import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import { Children, type ReactNode, useState } from "react";

import { ShortTime } from "@/web/components/time";
import { Alert } from "@/web/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";

export interface CardStatus {
  label: string;
  icon?: ReactNode;
}

export function CardFrame({
  icon,
  title,
  status,
  meta,
  at,
  open,
  onOpenChange,
  body = "details",
  role,
  label,
  children,
}: {
  // The kind's icon, before the title.
  icon?: ReactNode;
  // One line saying what the card is: a string, or inline parts such as a `Crumb`.
  title: ReactNode;
  status?: CardStatus;
  // A short fact beside the status, such as how long it took.
  meta?: ReactNode;
  // When it happened, as an ISO time.
  at?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // "details" is a quiet panel of facts and values; "text" is what someone said, read as it is.
  body?: "details" | "text";
  role?: string;
  label?: string;
  // What opening shows; with none, the header is all there is.
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = open ?? expanded;
  const more = Children.toArray(children).some((child) => child !== "");
  return (
    <Alert role={role} aria-label={label} className="gap-2.5 bg-transparent px-3 py-2.5">
      <Collapsible
        open={isOpen}
        onOpenChange={(next) => {
          setExpanded(next);
          onOpenChange?.(next);
        }}
        className="flex min-w-0 flex-col gap-2.5"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {icon && (
            <span aria-hidden className="shrink-0 text-muted-foreground [&>svg]:size-4">
              {icon}
            </span>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground">
            {typeof title === "string" ? <span className="min-w-0 truncate">{title}</span> : title}
          </div>
          {status && (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground [&>svg]:size-3.5">
              {status.icon}
              {status.label}
            </span>
          )}
          {meta && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span>
          )}
          {at && <ShortTime iso={at} className="shrink-0 text-xs text-muted-foreground" />}
          {more && (
            <CollapsibleTrigger
              aria-label={isOpen ? "Hide details" : "Show details"}
              className="group/card -my-0.5 shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 transition-transform group-data-[panel-open]/card:rotate-180"
              />
            </CollapsibleTrigger>
          )}
        </div>
        {more && (
          <CollapsibleContent
            className={cn(
              "flex flex-col gap-3 [overflow-wrap:anywhere]",
              body === "details"
                ? "rounded-md bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground"
                : "text-sm",
            )}
          >
            {children}
          </CollapsibleContent>
        )}
      </Collapsible>
    </Alert>
  );
}
