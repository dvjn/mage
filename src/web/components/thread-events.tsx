// How each kind of thread event looks, with a labelled fallback for kinds this client does not
// know yet. A message is a row of the transcript: an avatar, who wrote it and when, then its text
// as markdown. The signed-in person's own rows carry their avatar in the accent colour.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";

import {
  type AnyThreadEvent,
  type ThreadEventSummary,
  threadEventSchema,
} from "@/shared/threads.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { Time } from "@/web/components/time";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { initialsOf } from "@/web/lib/initials";
import { meQuery } from "@/web/lib/queries";

type Renderers = {
  [Type in ThreadEventSummary["type"]]: ComponentType<{
    event: Extract<ThreadEventSummary, { type: Type }>;
  }>;
};

type MessageEvent = Extract<ThreadEventSummary, { type: "message" }>;

function authorOf(event: ThreadEventSummary) {
  return event.actor.kind === "user" ? event.actor.name : "Agent";
}

// A row of the transcript: the avatar beside a header with the author and the time, and the body
// flush with the header.
function TranscriptRow({
  avatar,
  author,
  at,
  label,
  children,
}: {
  avatar: ReactNode;
  author: string;
  at: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <article aria-label={label} className="flex gap-3">
      <div className="mt-0.5 shrink-0">{avatar}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{author}</span>
          <Time iso={at} className="text-xs text-muted-foreground" />
        </div>
        {children}
      </div>
    </article>
  );
}

function MessageRow({ event }: { event: MessageEvent }) {
  const me = useQuery(meQuery);
  const author = authorOf(event);
  const mine = event.actor.kind === "user" && event.actor.userId === me.data?.user.id;
  const avatar = (
    <Avatar size="sm">
      <AvatarFallback className={cn(mine && "bg-primary text-primary-foreground")}>
        {initialsOf(author)}
      </AvatarFallback>
    </Avatar>
  );
  return (
    <TranscriptRow
      avatar={avatar}
      author={author}
      at={event.createdAt}
      label={`Message from ${author}`}
    >
      <div className="flex flex-col gap-2 text-sm">
        {event.data.parts.map((part, index) => (
          <MessageResponse key={index}>{part.text}</MessageResponse>
        ))}
      </div>
    </TranscriptRow>
  );
}

const renderers: Renderers = {
  message: MessageRow,
};

export function ThreadEvent({ event }: { event: AnyThreadEvent }) {
  const known = threadEventSchema.safeParse(event);
  if (known.success) {
    const Renderer = renderers[known.data.type] as ComponentType<{ event: ThreadEventSummary }>;
    return <Renderer event={known.data} />;
  }
  return (
    <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      Unsupported event: {event.type}
    </div>
  );
}
