// How each row of a thread's transcript looks. A message is an avatar, who wrote it and when, then
// its text as markdown; the signed-in person's own rows carry their avatar in the accent colour. An
// agent reply that was cut short says so, a run that failed says why, and an event this client does
// not know yet gets a labelled placeholder.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { AgentRow, HumanRow, PendingMessage, TranscriptRow } from "@/shared/transcript.ts";
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

function HumanMessage({ row, waiting = false }: { row: HumanRow; waiting?: boolean }) {
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
      note={
        (row.quiet || waiting) && (
          <span className="text-xs text-muted-foreground">{waiting ? "waiting" : "aside"}</span>
        )
      }
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

function AgentReply({ row }: { row: AgentRow }) {
  const ending = ENDINGS[row.status];
  return (
    <TranscriptRowFrame
      avatar={
        <Avatar size="sm">
          <AvatarFallback>{initialsOf("Agent")}</AvatarFallback>
        </Avatar>
      }
      author="Agent"
      at={row.startedAt}
      label="Message from Agent"
      note={ending && <span className="text-xs text-muted-foreground">{ending}</span>}
    >
      <div className="flex flex-col gap-2 text-sm" aria-busy={row.status === "streaming"}>
        <MessageResponse>{row.text}</MessageResponse>
      </div>
    </TranscriptRowFrame>
  );
}

// A message the agent has not taken in yet, after the transcript.
export function WaitingMessage({ message }: { message: PendingMessage }) {
  return <HumanMessage row={{ kind: "human", ...message, quiet: false }} waiting />;
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
    case "unknown":
      return (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Unsupported event: {row.type}
        </div>
      );
  }
}
