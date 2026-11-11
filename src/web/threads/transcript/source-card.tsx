// Who or what a transcript row came from, as a card that opens from its avatar on hover or focus:
// its name and kind, a line on where it came from, a few facts, and a way to open it. It only
// tells; nothing on it changes anything.

import { cn } from "cn";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Badge } from "@/web/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/web/components/ui/hover-card";

export interface Source {
  name: string;
  // What the source is: a person's standing in the thread, an agent, or the system.
  kind: string;
  // Initials or an icon, shown in its avatar.
  mark: ReactNode;
  // The avatar's own colour, as for the reader's own messages.
  markClassName?: string;
  subtitle?: ReactNode;
  facts?: { label: string; value: ReactNode }[];
  // A link that opens the source.
  open?: ReactNode;
}

export function SourceCard({ source }: { source: Source }) {
  const { name, kind, mark, markClassName, subtitle, facts = [], open } = source;
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
        aria-label={`About ${name}`}
      >
        <Avatar size="sm">
          <AvatarFallback className={cn("[&>svg]:size-3.5", markClassName)}>{mark}</AvatarFallback>
        </Avatar>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex w-72 flex-col gap-3 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar>
            <AvatarFallback className={cn("[&>svg]:size-4", markClassName)}>{mark}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{name}</span>
              <Badge variant="secondary" className="shrink-0">
                {kind}
              </Badge>
            </div>
            {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {facts.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className="min-w-0 truncate">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {open}
      </HoverCardContent>
    </HoverCard>
  );
}
