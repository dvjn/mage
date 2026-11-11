// The rows settings cards list things in, and the small badges that tag them.

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/web/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";

// One thing in a settings card as a collapsible row: its title and badges, a line about it, and a
// control beside it; what it holds inside, dimmed while it is off.
export function SettingsRow({
  title,
  badge,
  meta,
  open,
  onOpenChange,
  on = true,
  control,
  children,
}: {
  title: string;
  badge?: ReactNode;
  meta?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  on?: boolean;
  control?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} render={<section aria-label={title} />}>
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger className="group/trigger flex w-full items-start gap-2 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="flex h-6 shrink-0 items-center">
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
            </span>
            {/* On a phone the line about it goes under the title. */}
            <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "truncate text-base leading-6 font-semibold",
                    !on && "text-muted-foreground",
                  )}
                >
                  {title}
                </span>
                {badge}
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground sm:ml-auto">
                {meta}
              </span>
            </span>
          </CollapsibleTrigger>
        </h2>
        {control}
      </div>
      <CollapsibleContent
        className={cn("mb-3 ml-[7px] border-l-2 pl-3 sm:pl-[15px]", !on && "opacity-60")}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// A tag beside a row's title or name, as whose it is or how it stands: neutral, good, asking for
// something, or failing.
export function RowBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "ask" | "error";
}) {
  return (
    <Badge
      variant={tone === "ok" ? "secondary" : tone === "error" ? "destructive" : "outline"}
      className={cn("h-4 px-1.5 text-[10px]", tone === "ask" && "border-tool-ask/40 text-tool-ask")}
    >
      {children}
    </Badge>
  );
}
