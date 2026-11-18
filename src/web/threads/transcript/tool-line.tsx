// A tool call as one line with the tool and what became of the call, which opens on its input and
// output. A call that started a subagent says where the subagent stands now, with a way to open it,
// and a subagent call opens on links to where it had its effect too. A link to the call opens it.
// A call that made calls, as a script or a job, opens on its input and output first, then on its
// calls behind one line that counts them, grouped by tool; a job shows in place of the Start that
// made it. A call waiting for approval under it keeps every line above it open.

import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  CheckIcon,
  ChevronRightIcon,
  HandIcon,
  HourglassIcon,
  PowerOffIcon,
  SkipForwardIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { missesOf, type Standing } from "@/shared/call-outcome.ts";
import type { SubagentState } from "@/shared/subagents.ts";
import { FORMER_TOOL_IDS, type ToolDefinition } from "@/shared/tools.ts";
import type { CallEffect, ToolRow } from "@/shared/threads/rows.ts";
import { ToolInput, ToolOutput, ToolOutputSoFar } from "@/web/agent/tool-value";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { Spinner } from "@/web/components/ui/spinner";
import { WithTooltip } from "@/web/components/with-tooltip";
import { usePrinted } from "@/web/threads/event-stream";
import { useElapsed } from "@/web/threads/transcript/work-card";
import { CancelJob, MoveToBackground } from "@/web/threads/transcript/activity-actions";
import {
  byTool,
  type CallItem,
  type CallNode,
  callsKey,
  callsUnder,
  nodeId,
  nodeLineKey,
  openForWaiting,
  runningNow,
  tallyOf,
  treeOf,
} from "@/web/threads/transcript/call-tree";
import { rowElementId, RowLink, useRowFocus, useRowLit } from "@/web/threads/transcript/row-focus";
import { GIVES_WAY, ToolCrumb, useToolPath } from "@/web/threads/transcript/tool-crumb";
import { isScheduleOrWebhook } from "@/web/threads/transcript/schedule-or-webhook";
import { displayName } from "@/web/lib/people.ts";

// Where a subagent stands, in words.
export const SUBAGENT_STATES: Record<SubagentState, string> = {
  queued: "Queued",
  working: "Working",
  idle: "Idle",
  stopped: "Stopped",
  archived: "Archived",
};

// What a working subagent waits on, in words.
export const SUBAGENT_NEEDS = { decision: "needs approval", answer: "asked a question" } as const;

// Where a subagent call had its effect, in words.
const EFFECTS: Record<CallEffect["kind"], (name: string) => string> = {
  task: (name) => `Task in ${name}`,
  message: (name) => `Message to ${name}`,
  thread: (name) => name,
};

const TRIGGER =
  "group/tool relative flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left hover:text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0";
const CHEVRON = "transition-transform group-data-[panel-open]/tool:rotate-90";

// How long a call took to run, from a second on; nothing below that.
export function duration(ms: number | null) {
  return ms !== null && ms >= 1000 ? `${Math.round(ms / 1000)}s` : null;
}

// The definition of the tool a call was made with, under its former id too.
export function definitionOf(tools: readonly ToolDefinition[] | undefined, row: ToolRow) {
  return tools?.find((tool) => tool.name === (FORMER_TOOL_IDS[row.toolId] ?? row.toolId));
}

// The icon of a row that holds calls, by where they stand.
export function StandingIcon({ standing }: { standing: Standing }) {
  switch (standing) {
    case "waiting":
      return <HandIcon className="text-warning" />;
    case "running":
      return <Spinner />;
    case "failed":
      return <XIcon />;
    case "skipped":
      return <SkipForwardIcon />;
    case "done":
      return <CheckIcon className="text-foreground" />;
  }
}

// Whether something is held open: by the page where it holds what is open, else here; and always
// while it is forced open.
function useHeldOpen(key: string, forced: boolean) {
  const focus = useRowFocus();
  const [own, setOwn] = useState(false);
  return {
    open: forced || (focus ? focus.opened.has(key) : own),
    onOpenChange: (next: boolean) => (focus ? focus.onOpenChange([key], next) : setOwn(next)),
  };
}

// How many of something, in words.
export function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The calls under a call at every depth, and those that did not run as asked, in words.
function tallyText(node: CallNode, noun: string) {
  const { calls, outcomes } = tallyOf(node);
  return [counted(calls, noun), ...missesOf(outcomes)].join(" · ");
}

// A tool call that ran, is running or did not run, as one line with the tool's breadcrumb, what
// became of the call, who decided on it and whose credentials it ran with, which opens on its input
// and output, and on the calls it made where it made any.
export function ToolLine({
  row,
  definition,
  under,
  tools,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  // The calls under it, at every depth.
  under?: readonly ToolRow[];
  // The tools' definitions, for the calls under it and a job that shows in its place.
  tools?: readonly ToolDefinition[];
}) {
  const node = treeOf(row, callsUnder(under ?? []));
  const forced = openForWaiting(node);
  return (
    <CallLine
      node={node}
      definition={node.start ? definitionOf(tools, node.row) : definition}
      startDefinition={node.start && definition}
      tools={tools}
      forced={forced}
    />
  );
}

function CallLine({
  node,
  definition,
  startDefinition,
  tools,
  forced,
  nested = false,
}: {
  node: CallNode;
  definition: ToolDefinition | undefined;
  startDefinition?: ToolDefinition;
  tools: readonly ToolDefinition[] | undefined;
  // What is held open so that a call waiting for approval shows.
  forced: ReadonlySet<string>;
  // Shown under the call that made it, which names it.
  nested?: boolean;
}) {
  const { row, start } = node;
  const toolPath = useToolPath();
  const by = row.decision ? displayName(row.decision.by) : undefined;
  // Who let the call run, where someone did.
  const allowed =
    by && (row.decision?.scope === "for_now" ? `allowed for now by ${by}` : `allowed by ${by}`);
  let icon: ReactNode;
  let status: string;
  let who: string | undefined;
  switch (row.state) {
    case "completed":
      icon = <CheckIcon className="text-foreground" />;
      status = row.answers ? "Answered" : "Ran";
      who = row.answers ? by && `by ${by}` : allowed;
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
    case "cancelled":
      icon = <XIcon />;
      status = "Stopped";
      break;
    case "skipped":
      icon = <SkipForwardIcon />;
      status = "Skipped";
      who = by && `by ${by}`;
      break;
    default:
      if (row.state === "waiting") {
        icon = <HandIcon className="text-warning" />;
        status = "Waiting for approval";
      } else {
        icon = <Spinner />;
        status = "Running";
      }
  }
  // A background call says where its job stands.
  const work = row.work && !isScheduleOrWebhook(row) ? row.work : null;
  if (work) {
    who = undefined;
    switch (work.status) {
      case "waiting":
        icon = <HandIcon className="text-warning" />;
        status = "Waiting for approval";
        break;
      case "queued":
        icon = <Spinner />;
        status = "Queued";
        break;
      case "completed":
        icon = <CheckIcon className="text-foreground" />;
        status = "Done";
        break;
      case "failed":
        icon = <XIcon />;
        status = "Failed";
        break;
      case "cancelled":
        icon = <SquareIcon />;
        status = "Cancelled";
        break;
      case "interrupted":
        icon = <PowerOffIcon />;
        status = "Interrupted";
        break;
      default:
        icon = <Spinner />;
        status = "Running";
    }
  }
  const job = work?.kind === "job";
  const { subagent } = row;
  if (subagent) {
    status = SUBAGENT_STATES[subagent.state];
    who = subagent.needs && SUBAGENT_NEEDS[subagent.needs];
    if (subagent.state === "working" || subagent.state === "queued") icon = <Spinner />;
  }
  // A call moved to the background says so; one started there is marked.
  const moved =
    row.output?.ok &&
    (row.output.value as { movedToBackground?: unknown } | null)?.movedToBackground;
  if (moved && !work) status = "Moved to background";
  // What became of the call follows the tool, item by item, with whose own credentials it ran.
  const outcome = [status, who, row.ranAs && `as ${displayName(row.ranAs)}`]
    .filter(Boolean)
    .join(" · ");
  const holds = node.calls.length > 0;
  const tally = holds ? tallyText(node, "call") : null;
  // A call that is running counts its time; a background call's is its job's.
  const waiting = status === "Waiting for approval";
  const running = row.state === "ready";
  const goingOn = job ? work.status === "running" || work.status === "queued" : running;
  const elapsed = useElapsed(
    work ?? { startedAt: row.requestedAt, ...(!running && { endedAt: row.requestedAt }) },
  );
  const took = work || running ? elapsed : duration(row.ms);
  const focus = useRowFocus();
  const lit = useRowLit(row.id);
  const startLit = useRowLit(start?.id);
  const key = nodeLineKey(node);
  const held = useHeldOpen(key, forced.has(key));
  const now = holds && !held.open ? runningNow(node) : undefined;
  // Shown under the call that made it, or in the place of the Start that did.
  const placed = nested || !!start;
  const label = [`${toolPath(row, placed)} · ${outcome}`, tally].filter(Boolean).join(" · ");
  const trigger = (
    <CollapsibleTrigger
      aria-label={label}
      aria-description={lit || startLit ? "Linked tool call" : undefined}
      className={TRIGGER}
    >
      <ChevronRightIcon className={CHEVRON} />
      {icon}
      {job && (
        <WithTooltip label="Background job">
          <HourglassIcon aria-hidden />
        </WithTooltip>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <ToolCrumb row={row} nested={placed} className="font-medium" />
        <span className={cn(GIVES_WAY, waiting && "text-warning")}>· {outcome}</span>
        {tally && <span className="shrink-0 tabular-nums">· {tally}</span>}
      </span>
      {took && <span className="shrink-0 tabular-nums">{took}</span>}
    </CollapsibleTrigger>
  );
  // The input it was asked with and what it gave back: a job started by a Start, the tool and
  // input it was started with, and its id with its result.
  const asStarted = !!start && !holds;
  const output = job ? (
    <JobOutput row={row} goingOn={goingOn || waiting} holds={holds} />
  ) : row.output ? (
    <ToolOutput output={row.output} schema={definition?.outputSchema} />
  ) : goingOn || (waiting && holds) ? (
    <SoFar callId={row.id} always={holds} />
  ) : null;
  return (
    <Collapsible
      id={rowElementId(row.id)}
      data-lit={lit || startLit || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") focus?.dismiss?.(row.id);
      }}
      onPointerDownCapture={() => focus?.dismiss?.(row.id)}
      onKeyDownCapture={() => focus?.dismiss?.(row.id)}
      open={held.open}
      onOpenChange={held.onOpenChange}
      className={cn("rounded-md text-xs text-muted-foreground", (lit || startLit) && "attention")}
      // A call shown apart from the call that made it sits a step in for each level.
      style={!placed && row.depth ? { paddingLeft: `${row.depth * 1.25}rem` } : undefined}
    >
      {start && <span id={rowElementId(start.id)} />}
      {subagent ? (
        <div className="flex items-center gap-2">
          {trigger}
          <Link
            to="/t/$threadId"
            params={{ threadId: subagent.threadId }}
            aria-label={`Open ${subagent.name}`}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
          >
            Open
          </Link>
        </div>
      ) : row.canBackground ? (
        <div className="flex items-center gap-2">
          {trigger}
          <MoveToBackground row={row} />
        </div>
      ) : work?.canCancel ? (
        <div className="flex items-center gap-2">
          {trigger}
          <CancelJob row={row} />
        </div>
      ) : (
        trigger
      )}
      {now && (
        <div className="flex min-w-0 items-center gap-1.5 py-0.5 pl-5 [&>svg]:size-3.5 [&>svg]:shrink-0">
          <Spinner />
          <span className="flex min-w-0 items-center gap-1">
            <ToolCrumb row={now.row} nested />
          </span>
        </div>
      )}
      <CollapsibleContent className="mt-1 flex flex-col gap-1">
        <div className="flex flex-col gap-3 rounded-md bg-muted/20 px-3 py-2.5">
          {row.effects && (
            <nav aria-label="Effects" className="flex flex-wrap gap-1.5">
              {row.effects.map((effect) => (
                <RowLink
                  key={`${effect.threadId}:${effect.rowId ?? ""}`}
                  threadId={effect.threadId}
                  rowId={effect.rowId}
                  className="rounded-md border bg-background px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
                >
                  {EFFECTS[effect.kind](effect.name)}
                </RowLink>
              ))}
            </nav>
          )}
          {asStarted ? (
            <ToolInput value={start.input} schema={startDefinition?.inputSchema} />
          ) : (
            <ToolInput value={row.input} schema={definition?.inputSchema} />
          )}
          {output}
        </div>
        {holds && <CallsUnder node={node} tools={tools} forced={forced} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

// What a running call printed so far, where it printed anything or always.
function SoFar({ callId, always }: { callId: string; always: boolean }) {
  const text = usePrinted(callId);
  if (!text && !always) return null;
  return <ToolOutputSoFar text={text} />;
}

// What a job gave back: while it goes on, what it printed so far where it prints, as a script
// does, else its id; once it ended, its id with its result.
function JobOutput({ row, goingOn, holds }: { row: ToolRow; goingOn: boolean; holds: boolean }) {
  const text = usePrinted(row.id);
  if (goingOn && (text || holds)) return <ToolOutputSoFar text={text} />;
  const ended = row.output;
  if (ended && (!ended.ok || ended.large)) return <ToolOutput output={ended} />;
  return (
    <ToolOutput
      title={goingOn ? "Output so far" : "Output"}
      output={{ ok: true, value: { job: row.id, ...(ended?.ok && { result: ended.value }) } }}
    />
  );
}

// The calls a call made, behind one line counting them, which opens on them grouped by tool.
function CallsUnder({
  node,
  tools,
  forced,
}: {
  node: CallNode;
  tools: readonly ToolDefinition[] | undefined;
  forced: ReadonlySet<string>;
}) {
  const key = callsKey(nodeId(node));
  const held = useHeldOpen(key, forced.has(key));
  const count = tallyText(node, "tool call");
  const line = (child: CallNode) => (
    <CallLine
      key={nodeId(child)}
      node={child}
      definition={definitionOf(tools, child.row)}
      startDefinition={child.start && definitionOf(tools, child.start)}
      tools={tools}
      forced={forced}
      nested
    />
  );
  return (
    <div className="flex flex-col gap-1 pl-5">
      <Collapsible open={held.open} onOpenChange={held.onOpenChange}>
        <CollapsibleTrigger aria-label={count} className={TRIGGER}>
          <ChevronRightIcon className={CHEVRON} />
          <span className="font-medium">{count}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1 flex flex-col gap-1 pl-5">
          {byTool(node).map((item) =>
            item.kind === "call" ? (
              line(item.node)
            ) : (
              <ToolCalls key={item.key} item={item} forced={forced}>
                {item.nodes.map((child) => line(child))}
              </ToolCalls>
            ),
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// The calls of one tool among a call's calls: the tool, how many times it was called, and how
// many of those did not run as asked or are running, which opens on the calls in the order they
// were made. It stays open while a call in it is, as when a call opened alone gains a second.
function ToolCalls({
  item,
  forced,
  children,
}: {
  item: Extract<CallItem, { kind: "tool" }>;
  forced: ReadonlySet<string>;
  children: ReactNode;
}) {
  const focus = useRowFocus();
  const lines = item.nodes.map(nodeLineKey);
  const lineOpen = !!focus && lines.some((key) => focus.opened.has(key));
  const held = useHeldOpen(item.key, forced.has(item.key) || lineOpen);
  const toolPath = useToolPath();
  const first = item.nodes[0]!.row;
  const running = item.outcomes.filter((outcome) => outcome === "running").length;
  const counts = [
    `×${item.nodes.length}`,
    ...missesOf(item.outcomes),
    running > 0 && `${running} running`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Collapsible
      open={held.open}
      onOpenChange={(next) => {
        if (!next && focus) focus.onOpenChange([item.key, ...lines], false);
        else held.onOpenChange(next);
      }}
      className="text-xs text-muted-foreground"
    >
      <CollapsibleTrigger aria-label={`${toolPath(first, true)} · ${counts}`} className={TRIGGER}>
        <ChevronRightIcon className={CHEVRON} />
        <StandingIcon standing={item.standing} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <ToolCrumb row={first} nested className="font-medium" />
          <span className="shrink-0 tabular-nums">· {counts}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-1 pl-5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
