// How each row of a thread's transcript looks. A message is an avatar, who wrote it and when, then
// its text as markdown, with a copy button on hover; the signed-in person's own rows carry their
// avatar in the accent colour. An agent reply names the model that wrote it and, on hover, the
// tokens it used, and shows what the model thought first, folded away once it answers. An
// agent reply that was cut short says so, a run that failed says why and what to do about it, the
// last run that failed or was stopped can be tried again, and an event this client does not know
// yet gets a labelled placeholder.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Usage } from "@/shared/threads.ts";
import type { AgentRow, FailureRow, HumanRow, TranscriptRow } from "@/shared/transcript.ts";
import { MessageAction, MessageResponse } from "@/web/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/web/components/ai-elements/reasoning";
import { CONNECTION_LABELS } from "@/web/components/model-picker";
import { Time } from "@/web/components/time";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Button } from "@/web/components/ui/button";
import { useMinute } from "@/web/hooks/use-minute";
import { initialsOf } from "@/web/lib/initials";
import { meQuery, modelsQuery } from "@/web/lib/queries";
import { timeUntil } from "@/web/lib/time";

// A row of the transcript: the avatar beside a header with the author and the time, and the body
// flush with the header.
function TranscriptRowFrame({
  avatar,
  author,
  at,
  label,
  note,
  actions,
  children,
}: {
  avatar: ReactNode;
  author: string;
  at: string;
  label: string;
  note?: ReactNode;
  // Shown beside the author while the row is hovered or focused.
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article aria-label={label} className="group/row flex gap-3">
      <div className="mt-0.5 shrink-0">{avatar}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{author}</span>
          <Time iso={at} className="text-xs text-muted-foreground" />
          {note}
          {actions && (
            <div className="-my-1 ml-auto flex items-center gap-2 self-center text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
              {actions}
            </div>
          )}
        </div>
        {children}
      </div>
    </article>
  );
}

function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction
      label="Copy message"
      size="icon-xs"
      disabled={!text}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  );
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
const exact = new Intl.NumberFormat();

// Tokens read and written, short, with the exact counts on hover.
export function TokenCount({ usage, className }: { usage: Usage; className?: string }) {
  const total = usage.inputTokens + usage.outputTokens;
  return (
    <span
      className={className}
      title={`${exact.format(usage.inputTokens)} input · ${exact.format(usage.outputTokens)} output tokens`}
    >
      {compact.format(total)} tokens
    </span>
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
      actions={<CopyMessage text={row.text} />}
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

// The model's name from the org's list, or the id its ref ends with.
function useModelName(ref: string | null) {
  const models = useQuery(modelsQuery);
  if (!ref) return null;
  return models.data?.models.find((model) => model.ref === ref)?.name ?? ref.split("/").pop();
}

function AgentReply({ row }: { row: AgentRow }) {
  const ending = ENDINGS[row.status];
  const streaming = row.status === "streaming";
  const model = useModelName(row.model);
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={row.startedAt}
      label="Message from Agent"
      note={
        <>
          {model && <span className="text-xs text-muted-foreground">{model}</span>}
          {ending && <span className="text-xs text-muted-foreground">{ending}</span>}
        </>
      }
      actions={
        !streaming && (
          <>
            <CopyMessage text={row.text} />
            {row.usage && <TokenCount usage={row.usage} />}
          </>
        )
      }
    >
      <div className="flex flex-col gap-2 text-sm" aria-busy={streaming}>
        {row.reasoning && (
          <Reasoning
            isStreaming={streaming && !row.text}
            duration={
              row.thoughtMs === null ? undefined : Math.max(1, Math.ceil(row.thoughtMs / 1000))
            }
          >
            <ReasoningTrigger />
            <ReasoningContent>{row.reasoning}</ReasoningContent>
          </Reasoning>
        )}
        {streaming && !row.text ? (
          !row.reasoning && caret
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

// What can be done from a row: try its run again, or open the model picker.
export interface RowActions {
  retry?: () => void;
  pickModel?: () => void;
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button size="xs" variant="outline" onClick={onRetry}>
      <RotateCcwIcon />
      Retry
    </Button>
  );
}

// Why the run failed, in words for its kind, with the step that helps and what the provider said.
function FailureNotice({ row, actions }: { row: FailureRow; actions: RowActions }) {
  // When a limit resets is said relative to now.
  useMinute();
  const label = row.connection ? CONNECTION_LABELS[row.connection] : "the provider";
  let summary: ReactNode = `The agent stopped: ${row.error}`;
  let step: ReactNode = null;
  switch (row.failure) {
    case "auth":
      summary = `The ${label} sign-in no longer works.`;
      step = (
        <Button size="xs" variant="outline" render={<Link to="/settings" />} nativeButton={false}>
          Reconnect {label}
        </Button>
      );
      break;
    case "limit": {
      const resets = row.resetsAt && timeUntil(row.resetsAt);
      summary = resets ? `Limit reached, resets ${resets}.` : "Limit reached.";
      break;
    }
    case "model":
      summary = `${label === "the provider" ? "The provider" : label} cannot use this model.`;
      if (actions.pickModel) {
        step = (
          <Button size="xs" variant="outline" onClick={actions.pickModel}>
            Pick another model
          </Button>
        );
      }
      break;
    case "network":
      summary = `Couldn't reach ${label}.`;
      break;
  }
  return (
    <div
      role="status"
      aria-label="Run failed"
      className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto">{summary}</span>
        {step}
        {actions.retry && <RetryButton onRetry={actions.retry} />}
      </div>
      {row.detail && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-1 font-mono break-words whitespace-pre-wrap">{row.detail}</pre>
        </details>
      )}
    </div>
  );
}

export function TranscriptItem({
  row,
  actions = {},
}: {
  row: TranscriptRow;
  actions?: RowActions;
}) {
  switch (row.kind) {
    case "human":
      return <HumanMessage row={row} />;
    case "agent":
      return <AgentReply row={row} />;
    case "failure":
      return <FailureNotice row={row} actions={actions} />;
    case "stop":
      return (
        <div role="status" className="flex items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground">
            {row.by ? `${row.by} stopped the agent` : "The agent was stopped"}
          </p>
          {actions.retry && <RetryButton onRetry={actions.retry} />}
        </div>
      );
    case "unknown":
      return (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Unsupported event: {row.type}
        </div>
      );
  }
}
