// How each kind of thread event looks, with a labelled fallback for kinds this client does not
// know yet. Messages are shown as AI SDK UI messages, the shape the chat components take, with
// their text rendered as markdown.

import type { UIMessage } from "ai";
import type { ReactNode } from "react";

import { Message, MessageContent, MessageResponse } from "@/web/components/ai-elements/message";

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

type MessageEvent = Extract<ThreadEventSummary, { type: "message" }>;

function authorOf(event: ThreadEventSummary) {
  return event.actor.kind === "user" ? event.actor.name : "Agent";
}

// People's messages are the user's side of the conversation; the agent's are the assistant's.
export function toUIMessage(event: MessageEvent): UIMessage {
  return {
    id: event.id,
    role: event.actor.kind === "user" ? "user" : "assistant",
    parts: event.data.parts.map((part) => ({ type: "text", text: part.text })),
  };
}

function textOf(message: UIMessage) {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

const renderers: Renderers = {
  message: (event) => {
    const message = toUIMessage(event);
    return (
      <Message from={message.role} role="article" aria-label={`Message from ${authorOf(event)}`}>
        <span className="text-xs font-medium text-muted-foreground group-[.is-user]:ml-auto">
          {authorOf(event)}
        </span>
        <MessageContent>
          {textOf(message).map((text, index) => (
            <MessageResponse key={index}>{text}</MessageResponse>
          ))}
        </MessageContent>
      </Message>
    );
  },
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
