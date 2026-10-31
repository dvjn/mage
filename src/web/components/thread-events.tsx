// How each row of a thread's transcript looks. A message is an avatar, who wrote it and when, noted
// when its author was a guest of the thread or was removed from its org, then its text as markdown,
// with a copy button on hover; the signed-in person's own rows carry their avatar in the accent
// colour. An agent's turn, its tool calls and its reply, sits under one Agent header that names the
// model that wrote the reply; the reply shows what the model thought first, folded away once it
// answers. An agent reply that was cut short says so, a run that failed says why and what to do
// about it, the last run that failed or was stopped can be tried again, and an event this client
// does not know yet gets a labelled placeholder. Tool calls show by their tool's definition alone,
// its title or else its name, as for any tool (loading a skill as Loaded skill and the skill's
// name), and an MCP server's tool is a breadcrumb, its server
// in muted text before a chevron and the tool. One waiting for a decision is a card from the agent
// headed by the tool under a hand, tagged when the call asks each time, with the input and Allow,
// Allow for now and Deny in a row, enabled for the people who may run the tool and marked paused for
// everyone else; every other call is a line with the tool and what became of the call, which opens
// on its input and output.

import { cn } from "cn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  HandIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { LOAD_SKILL } from "@/shared/skills.ts";
import type { ToolRisk, ToolScope } from "@/shared/threads.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import type {
  AgentRow,
  AgentTurn,
  FailureRow,
  HumanRow,
  ToolRow,
  TranscriptRow,
} from "@/shared/transcript.ts";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/web/components/ai-elements/confirmation";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { CopyButton } from "@/web/components/copy-button";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/web/components/ai-elements/reasoning";
import { CONNECTION_LABELS } from "@/web/components/model-picker";
import { Time } from "@/web/components/time";
import { ToolInput, ToolResult } from "@/web/components/tool-value";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { Spinner } from "@/web/components/ui/spinner";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useMinute } from "@/web/hooks/use-minute";
import { initialsOf } from "@/web/lib/initials";
import { meQuery, modelsQuery } from "@/web/lib/queries";
import { timeUntil } from "@/web/lib/time";
import { callResultOf } from "@/web/lib/tool-value";

// A row of the transcript: the avatar beside a header with the author and the time, and the body
// flush with the header.
function TranscriptRowFrame({
  avatar,
  author,
  at,
  label,
  note,
  actions,
  continued,
  children,
}: {
  avatar: ReactNode;
  author: string;
  at: string;
  label: string;
  note?: ReactNode;
  // Shown beside the author while the row is hovered or focused.
  actions?: ReactNode;
  // Follows another row of the same author's turn: its body alone, under that row's header, with
  // any note of its own above.
  continued?: boolean;
  children: ReactNode;
}) {
  if (continued) {
    return (
      <article aria-label={label} className="group/row relative flex flex-col gap-1 pl-9">
        {note && (
          <div className="flex items-baseline gap-2 text-xs text-muted-foreground">{note}</div>
        )}
        {children}
        {actions && (
          <div className="absolute top-0 right-0 flex items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        )}
      </article>
    );
  }
  return (
    <article aria-label={label} className="group/row flex gap-3">
      <div className="mt-0.5 shrink-0">{avatar}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{author}</span>
          <Time iso={at} className="text-xs text-muted-foreground" />
          {/* Each note after the time reads as its own item. */}
          {note && (
            <span className="flex items-baseline gap-2 text-xs text-muted-foreground *:before:mr-2 *:before:content-['·']">
              {note}
            </span>
          )}
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
      note={
        (row.guest || row.quiet || row.author.former) && (
          <>
            {row.author.former && <span>former member</span>}
            {row.guest && <span>Guest</span>}
            {row.quiet && <span>aside</span>}
          </>
        )
      }
      actions={<CopyButton label="Copy message" value={row.text} />}
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
  const listed = [...(models.data?.models ?? []), ...(models.data?.turnedOff ?? [])];
  return listed.find((model) => model.ref === ref)?.name ?? (ref.split("/").pop() || null);
}

function AgentReply({ row, continued }: { row: AgentRow; continued: boolean }) {
  const ending = ENDINGS[row.status];
  const streaming = row.status === "streaming";
  const model = useModelName(row.model);
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={row.startedAt}
      label="Message from Agent"
      continued={continued}
      // The turn's header names the model.
      note={
        (!continued || ending) && (
          <>
            {!continued && model && <span>{model}</span>}
            {ending && <span>{ending}</span>}
          </>
        )
      }
      actions={!streaming && <CopyButton label="Copy message" value={row.text} />}
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

// The agent's row while a run has started but no words have arrived yet; continued when it follows
// the agent's own rows.
export function AgentStarting({ at, continued }: { at: string; continued?: boolean }) {
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={at}
      label="Message from Agent"
      continued={continued}
    >
      <div className="flex text-sm" aria-busy>
        {caret}
      </div>
    </TranscriptRowFrame>
  );
}

// What can be done from a row: try its run again, open the model picker, or decide on a tool call
// for those who may.
export interface RowActions {
  retry?: () => void;
  pickModel?: () => void;
  decide?: (allow: boolean, scope: ToolScope) => Promise<void>;
}

const ONLY_RUNNERS = "Only people who can run this here can decide";

// What a tool is called: its title, or its name where it has none; loading a skill names the skill.
function toolName(row: ToolRow, definition: ToolDefinition | undefined) {
  const skill = (row.input as { name?: unknown } | null)?.name;
  if (row.toolId === LOAD_SKILL && typeof skill === "string") {
    return row.state === "ran" ? `Loaded skill ${skill}` : `Load skill ${skill}`;
  }
  return definition?.title ?? row.toolId;
}

// What a tool is called, in words: its server's name before its own where it has a server.
function toolPath(row: ToolRow, definition: ToolDefinition | undefined) {
  return [definition?.toolset, toolName(row, definition)].filter(Boolean).join(" › ");
}

// An item of a flex row that grows from nothing into the room its siblings leave, up to its own
// width, so that it truncates before they do.
const GIVES_WAY = "min-w-0 max-w-max flex-1 truncate";

// What a tool is called, as a breadcrumb inside a flex row: its server's name in muted text and a
// chevron before its own where it has a server. Where the row is short, the server's name truncates
// first, sharing the room the tool's name leaves with any other item of the row that gives way the
// same, and the tool's own name only once the server's is gone. It takes the class given.
function ToolCrumb({
  row,
  definition,
  className,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  className?: string;
}) {
  return (
    <>
      {definition?.toolset && (
        <>
          <span className={cn(GIVES_WAY, "text-muted-foreground")}>{definition.toolset}</span>
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
      <span className={cn("min-w-0 truncate", className)}>{toolName(row, definition)}</span>
    </>
  );
}

// What a call's risk is called on its card; nothing for the usual one.
const RISK_TAGS: Partial<Record<ToolRisk, string>> = {
  ask: "Asks each time",
  review: "Needs review",
};

// A tool call waiting for a decision: the tool's breadcrumb under the hand, its input, and the
// buttons to decide.
function ToolCard({
  row,
  definition,
  decide,
  continued,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  decide?: RowActions["decide"];
  continued: boolean;
}) {
  const [deciding, setDeciding] = useState(false);
  function button(
    label: string,
    allow: boolean,
    scope: ToolScope,
    variant: "default" | "secondary" | "outline",
  ) {
    const action = (
      <ConfirmationAction
        variant={variant}
        className="w-full sm:w-auto"
        disabled={!decide || deciding}
        onClick={() => {
          if (!decide) return;
          setDeciding(true);
          void decide(allow, scope).finally(() => setDeciding(false));
        }}
      >
        {label}
      </ConfirmationAction>
    );
    if (decide) return action;
    return (
      <WithTooltip
        label={
          row.risk === "review"
            ? "Only someone who can run this and has not contributed to the conversation can review it"
            : ONLY_RUNNERS
        }
      >
        {/* A disabled control takes no pointer, so its wrapper holds the tooltip. */}
        <span className="inline-flex w-full sm:w-auto" tabIndex={0}>
          {action}
        </span>
      </WithTooltip>
    );
  }
  const tag = RISK_TAGS[row.risk];
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={row.requestedAt}
      label="Approval request"
      note={!decide && <span>Paused</span>}
      continued={continued}
    >
      <Confirmation
        approval={{ id: row.id }}
        state="approval-requested"
        className="gap-2.5 px-3 py-2.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <HandIcon
            aria-hidden
            className={cn("size-4 shrink-0", decide ? "text-status-waiting" : "text-status-paused")}
          />
          <ConfirmationTitle className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            <ToolCrumb row={row} definition={definition} className="font-semibold" />
          </ConfirmationTitle>
          {tag && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              {tag}
            </Badge>
          )}
        </div>
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <ToolInput value={row.input} schema={definition?.inputSchema} />
        </div>
        {row.risk === "review" && (
          <p className="text-xs text-muted-foreground">
            Waiting for review by someone who has not contributed to this conversation.
          </p>
        )}
        <ConfirmationRequest>
          <ConfirmationActions className="w-full flex-col items-stretch self-stretch sm:flex-row sm:items-center sm:justify-start">
            {button("Allow", true, "once", "default")}
            {row.risk === "normal" && button("Allow for now", true, "for_now", "secondary")}
            {button("Deny", false, "once", "outline")}
          </ConfirmationActions>
        </ConfirmationRequest>
      </Confirmation>
    </TranscriptRowFrame>
  );
}

// How long a call took to run, from a second on; nothing below that.
function duration(ms: number | null) {
  return ms !== null && ms >= 1000 ? `${Math.round(ms / 1000)}s` : null;
}

// A tool call that ran, is running or did not run, as one line with the tool's breadcrumb, what
// became of the call, and who decided on it, which opens on its input and output.
function ToolLine({
  row,
  definition,
  framed,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  // Directly under an Agent header, rather than aligned with the text beside its avatar.
  framed?: boolean;
}) {
  const by = row.decision?.by.name;
  // Who let the call run, where someone did.
  const allowed =
    by && (row.decision?.scope === "for_now" ? `allowed for now by ${by}` : `allowed by ${by}`);
  let icon: ReactNode;
  let status: string;
  let who: string | undefined;
  switch (row.state) {
    case "ran":
      icon = <CheckIcon className="text-foreground" />;
      status = "Ran";
      who = allowed;
      break;
    case "failed":
      icon = <XIcon />;
      status = "Failed";
      who = allowed;
      break;
    case "denied":
      icon = <XIcon />;
      status = "Denied";
      who = by && `by ${by}`;
      break;
    case "stale":
      icon = <TriangleAlertIcon />;
      status = "Denied";
      who = "the approval no longer held";
      break;
    case "stopped":
      icon = <XIcon />;
      status = "Stopped";
      break;
    default:
      icon = <Spinner />;
      status = row.waits && row.state === "pending" ? "Waiting" : "Running";
  }
  // What became of the call follows the tool, item by item.
  const outcome = [status, who].filter(Boolean).join(" · ");
  const took = duration(row.ms);
  return (
    <Collapsible className={cn("text-xs text-muted-foreground", !framed && "pl-9")}>
      <CollapsibleTrigger
        aria-label={`${toolPath(row, definition)} · ${outcome}`}
        className="group/tool flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0"
      >
        <ChevronRightIcon className="transition-transform group-data-[panel-open]/tool:rotate-90" />
        {icon}
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <ToolCrumb row={row} definition={definition} className="font-medium" />
          <span className={GIVES_WAY}>· {outcome}</span>
        </span>
        {took && <span className="shrink-0 tabular-nums">{took}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-3 rounded-md bg-muted px-3 py-2">
        <ToolInput value={row.input} schema={definition?.inputSchema} />
        {row.output && (
          <ToolResult result={callResultOf(row.output)} schema={definition?.outputSchema} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// A tool call that opens the agent's turn: the Agent header, naming the model the turn's reply was
// written with, over the call's line.
function ToolOpening({
  row,
  definition,
  turn,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  turn: AgentTurn;
}) {
  const model = useModelName(turn.model);
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={row.requestedAt}
      label="Message from Agent"
      note={model && <span>{model}</span>}
    >
      <ToolLine row={row} definition={definition} framed />
    </TranscriptRowFrame>
  );
}

function ToolCall({
  row,
  definition,
  decide,
  turn,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  decide?: RowActions["decide"];
  turn: AgentTurn;
}) {
  if (row.state === "pending" && row.waits) {
    return (
      <ToolCard row={row} definition={definition} decide={decide} continued={turn.continued} />
    );
  }
  if (!turn.continued) return <ToolOpening row={row} definition={definition} turn={turn} />;
  return <ToolLine row={row} definition={definition} />;
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
        <Button
          size="xs"
          variant="outline"
          render={<Link to="/org/providers" />}
          nativeButton={false}
        >
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
  tools = [],
  turn,
}: {
  row: TranscriptRow;
  actions?: RowActions;
  // The tools' definitions, by which their calls show.
  tools?: ToolDefinition[];
  // Where the row sits in the agent's turn, for the agent's own rows.
  turn: AgentTurn | null;
}) {
  switch (row.kind) {
    case "human":
      return <HumanMessage row={row} />;
    case "agent":
      // A step that only called tools shows as its calls.
      if (!turn) return null;
      return <AgentReply row={row} continued={turn.continued} />;
    case "tool":
      return (
        <ToolCall
          row={row}
          definition={tools.find((tool) => tool.name === row.toolId)}
          decide={actions.decide}
          turn={turn ?? { continued: false, model: null }}
        />
      );
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
