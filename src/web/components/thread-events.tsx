// How each row of a thread's transcript looks. A message is an avatar, who wrote it and when, then
// its text as markdown; the signed-in person's own rows carry their avatar in the accent colour. An
// agent reply that was cut short says so, a run that failed says why, and an event this client does
// not know yet gets a labelled placeholder.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { AgentRow, HumanRow, TranscriptRow } from "@/shared/transcript.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { Time } from "@/web/components/time";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { initialsOf } from "@/web/lib/initials";
import { meQuery } from "@/web/lib/queries";

// A row of the transcript: the avatar beside a header with the author and the time, and the body
// flush with the header.
function TranscriptRowFrame({
  avatar,
  author,
  at,
  label,
  note,
  children,
}: {
  avatar: ReactNode;
  author: string;
  at: string;
  label: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article aria-label={label} className="flex gap-3">
      <div className="mt-0.5 shrink-0">{avatar}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{author}</span>
          <Time iso={at} className="text-xs text-muted-foreground" />
          {note}
        </div>
        {children}
      </div>
    </article>
  );
}

function HumanMessage({ row }: { row: HumanRow }) {
  const me = useQuery(meQuery);
  const author = row.author.name;
  const mine = row.author.userId === me.data?.user.id;
  return (
    <TranscriptRowFrame
      avatar={
        <Avatar size="sm">
          <AvatarFallback className={cn(mine && "bg-primary text-primary-foreground")}>
            {initialsOf(author)}
          </AvatarFallback>
        </Avatar>
      }
      author={author}
      at={row.postedAt}
      label={`Message from ${author}`}
      note={row.quiet && <span className="text-xs text-muted-foreground">aside</span>}
    >
      <div className={cn("flex flex-col gap-2 text-sm", row.quiet && "text-muted-foreground")}>
        <MessageResponse>{row.text}</MessageResponse>
      </div>
    </TranscriptRowFrame>
  );
}

const ENDINGS: Partial<Record<AgentRow["status"], string>> = {
  interrupted: "Interrupted",
  failed: "Cut short",
};

const agentAvatar = (
  <Avatar size="sm">
    <AvatarFallback>{initialsOf("Agent")}</AvatarFallback>
  </Avatar>
);

// The blinking cursor the agent writes behind.
const caret = <span aria-hidden className="inline-block h-4 w-2 animate-pulse bg-foreground/70" />;

function AgentReply({ row }: { row: AgentRow }) {
  const ending = ENDINGS[row.status];
  const streaming = row.status === "streaming";
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={row.startedAt}
      label="Message from Agent"
      note={ending && <span className="text-xs text-muted-foreground">{ending}</span>}
    >
      <div className="flex flex-col gap-2 text-sm" aria-busy={streaming}>
        {streaming && !row.text ? (
          caret
        ) : (
          <MessageResponse isAnimating={streaming} caret="block">
            {row.text}
          </MessageResponse>
        )}
      </div>
    </TranscriptRowFrame>
  );
}

// The agent's row while a run has started but no words have arrived yet.
export function AgentStarting({ at }: { at: string }) {
  return (
    <TranscriptRowFrame avatar={agentAvatar} author="Agent" at={at} label="Message from Agent">
      <div className="flex text-sm" aria-busy>
        {caret}
      </div>
    </TranscriptRowFrame>
  );
}

export function TranscriptItem({ row }: { row: TranscriptRow }) {
  switch (row.kind) {
    case "human":
      return <HumanMessage row={row} />;
    case "agent":
      return <AgentReply row={row} />;
    case "failure":
      return (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          The agent stopped: {row.error}
        </p>
      );
    case "stop":
      return (
        <p role="status" className="text-center text-xs text-muted-foreground">
          {row.by ? `${row.by} stopped the agent` : "The agent was stopped"}
        </p>
      );
    case "unknown":
      return (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Unsupported event: {row.type}
        </div>
      );
  }
}
