// How each kind of thread event looks, with a labelled fallback for kinds this client does not
// know yet.

import type { ReactNode } from "react";

import {
  type AnyThreadEvent,
  type ThreadEventSummary,
  threadEventSchema,
} from "@/shared/threads.ts";

type Renderers = {
  [Type in ThreadEventSummary["type"]]: (
    event: Extract<ThreadEventSummary, { type: Type }>,
  ) => ReactNode;
};

function authorOf(event: ThreadEventSummary) {
  return event.actor.kind === "user" ? event.actor.name : "Agent";
}

const renderers: Renderers = {
  message: (event) => (
    <article className="flex flex-col gap-1" aria-label={`Message from ${authorOf(event)}`}>
      <span className="text-xs font-medium text-muted-foreground">{authorOf(event)}</span>
      <div className="whitespace-pre-wrap">
        {event.data.parts.map((part, index) => (
          <p key={index}>{part.text}</p>
        ))}
      </div>
    </article>
  ),
};

function render<Type extends ThreadEventSummary["type"]>(
  event: Extract<ThreadEventSummary, { type: Type }>,
) {
  return (renderers[event.type] as (event: ThreadEventSummary) => ReactNode)(event);
}

export function ThreadEvent({ event }: { event: AnyThreadEvent }) {
  const known = threadEventSchema.safeParse(event);
  if (known.success) return render(known.data);
  return (
    <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      Unsupported event: {event.type}
    </div>
  );
}
