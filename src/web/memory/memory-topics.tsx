// Memory entries under their topics, each with its type; where it shows more, a line about each
// entry and an action beside it.

import type { ReactNode } from "react";

import { MEMORY_TYPE_LABELS, type MemoryType } from "@/shared/memory.ts";
import { Badge } from "@/web/components/ui/badge";

interface Shown {
  id: string;
  type: MemoryType;
  text: string;
}

// The entries by topic, in the order each topic first comes.
export function byTopic<T extends Shown & { topic: string }>(entries: readonly T[]) {
  const topics = new Map<string, T[]>();
  for (const entry of entries) topics.set(entry.topic, [...(topics.get(entry.topic) ?? []), entry]);
  return [...topics].map(([topic, grouped]) => ({ topic, entries: grouped }));
}

export function MemoryTopics<T extends Shown>({
  topics,
  meta,
  action,
}: {
  topics: readonly { topic: string; entries: readonly T[] }[];
  meta?: (entry: T) => ReactNode;
  action?: (entry: T) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {topics.map(({ topic, entries }) => (
        <section key={topic} aria-label={topic} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {topic}
          </h3>
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <li key={entry.id} className="group flex min-h-8 items-start gap-3 py-1">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-sm break-words text-foreground">
                    <Badge variant="secondary" className="mr-1.5 h-5 align-middle font-normal">
                      {MEMORY_TYPE_LABELS[entry.type]}
                    </Badge>
                    {entry.text}
                  </p>
                  {meta && <p className="text-xs text-muted-foreground">{meta(entry)}</p>}
                </div>
                {action?.(entry)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
