// The cards of the activity tray's kinds other than tasks: one row for each background item, with
// its mark, name, what its kind says of it and where it stands, then its actions as a group of
// icon buttons on the right. Its name and "Go to message" lead to its row in the transcript, the
// record of it, and "Review" to what waits on the reader. What a reader may do with it, the
// server says; nothing here is behind a menu.

import { Link } from "@tanstack/react-router";
import {
  CornerUpLeftIcon,
  FingerprintPatternIcon,
  HandIcon,
  HistoryIcon,
  LinkIcon,
  SquareIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";

import type { ActivityItem } from "@/shared/jobs.ts";
import { HISTORY_PAGE } from "@/shared/schedules-and-webhooks.ts";
import type { ToolScope } from "@/shared/threads/events.ts";
import { CopyButton } from "@/web/components/copy-button";
import { NameDialog } from "@/web/components/name-dialog";
import { Button, buttonVariants } from "@/web/components/ui/button";
import { DialogHeader, DialogTitle } from "@/web/components/ui/dialog";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { ResponsiveDialog, ResponsiveDialogContent } from "@/web/components/responsive-dialog";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useMinute } from "@/web/hooks/use-minute";
import { plural } from "@/web/lib/plural";
import { fullTime, timeUntil } from "@/web/lib/time";
import { PagerControl, pageHeight, usePager, usePublishPager } from "@/web/threads/pager";
import { useStopRun } from "@/web/threads/mutations";
import { firedHistoryQuery, threadQuery } from "@/web/threads/queries";
import { KINDS, useElapsed } from "@/web/threads/transcript/work-card";
import { useBackgroundActions } from "@/web/threads/transcript/job-actions";
import { ToolCard } from "@/web/threads/transcript/tool-card";
import { RowLink, useGoToRow } from "@/web/threads/transcript/row-focus";
import { WorkControls } from "@/web/threads/transcript/work-controls";

function Detail({ item }: { item: ActivityItem }) {
  useMinute();
  const { work } = item;
  const elapsed = useElapsed(work);
  if (work.status === "paused") return <>Paused</>;
  if (work.subagent) {
    const { state, needs } = work.subagent;
    if (state === "working") {
      return needs ? (
        <>Waiting for {needs === "decision" ? "decision" : "an answer"}</>
      ) : (
        <>
          Working<span className="tabular-nums"> {elapsed}</span>
        </>
      );
    }
    return (
      <>
        {
          {
            queued: "Queued",
            idle: "Idle",
            stopped: "Stopped",
            archived: "Archived",
          }[state]
        }
      </>
    );
  }
  if (work.kind === "decision") return <>Waiting for approval</>;
  if (work.kind === "job") {
    return (
      <>
        {work.status === "waiting" ? "Waiting" : "Running"}
        <span className="tabular-nums"> {elapsed}</span>
      </>
    );
  }
  if (work.kind === "schedule") {
    const next = work.schedule?.nextRunAt;
    return next ? (
      <span title={fullTime(next)}>Next {timeUntil(next) ?? "soon"}</span>
    ) : (
      <>Scheduled</>
    );
  }
  // A webhook has no state to say beyond paused; its deliveries are notices in the transcript.
  return null;
}

// The colour of an item's state: what needs the reader is amber, a failure red, what runs blue;
// the rest is muted. The state is always said in words beside it.
export function toneOf({ attention, work }: ActivityItem) {
  if (attention === "failed") return "text-destructive";
  if (attention) return "text-warning";
  if (work.status === "running" || work.subagent?.state === "working") return "text-info";
  return "text-muted-foreground";
}

// What marks an item: a spinner while it runs, a hand while it waits for approval, its kind's icon
// otherwise, coloured when it failed or fires soon.
function Mark({ item }: { item: ActivityItem }) {
  const { work, attention } = item;
  if (work.status === "running") return <Spinner className="size-3.5 text-info" />;
  if (attention === "approval") {
    return <HandIcon aria-hidden className="size-3.5 text-warning" />;
  }
  return (
    <span className={`[&>svg]:size-3.5 ${toneOf(item)}`} title={KINDS[work.kind].label}>
      {KINDS[work.kind].icon}
    </span>
  );
}

// The one row of the panel: a single line with a hover background, whose name is its primary
// target. The name stretches over the row, so a click anywhere on it does the name's action, and
// the row's buttons sit above it with their own hover.
const ROW = "relative flex h-8 items-center gap-2 rounded-md px-1.5 text-sm hover:bg-muted/50";
const NAME =
  "min-w-12 flex-1 truncate rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:ring-2 focus-visible:ring-ring/50";

// The row's buttons, which line up on its right.
function Group({ children }: { children: ReactNode }) {
  return <div className="relative z-10 flex shrink-0 items-center gap-0.5">{children}</div>;
}

const stamp = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// An icon button that names itself in a tooltip, pressed when it is a toggle that is on.
function IconAction({
  label,
  tooltip = label,
  icon,
  onClick,
  disabled,
  pressed,
  className,
}: {
  label: string;
  // What the tooltip says, where it says more than the name.
  tooltip?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <WithTooltip label={tooltip}>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={label}
        className={className}
        {...(pressed !== undefined && { "aria-pressed": pressed })}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </Button>
    </WithTooltip>
  );
}

// A webhook's own buttons: copy its URL, require a signature or change or remove the secret, and
// name the header its deliveries carry their id in.
function WebhookControls({ item }: { item: ActivityItem }) {
  const actions = useBackgroundActions()?.webhook;
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const webhook = item.work.webhook!;
  if (!actions || !webhook.canChange) return null;
  return (
    <>
      {webhook.path && (
        <CopyButton
          label="Copy URL"
          size="icon-sm"
          icon={<LinkIcon />}
          value={window.location.origin + webhook.path}
        />
      )}
      <IconAction
        label={webhook.signed ? "Signature: on" : "Signature: off"}
        tooltip={webhook.signed ? "Signed · change or remove" : "Require signature"}
        icon={webhook.signed ? <ShieldCheckIcon /> : <ShieldIcon />}
        className={
          webhook.signed
            ? "text-success hover:text-success focus-visible:text-success"
            : "text-muted-foreground"
        }
        onClick={() => setOpen(true)}
      />
      <NameDialog
        open={open}
        onOpenChange={setOpen}
        title={webhook.signed ? "Change secret" : "Require signature"}
        action="Save"
        label="Secret"
        maxLength={200}
        secret
        hint="Requests must carry an X-Hub-Signature-256 header signed with this secret."
        extra={
          webhook.signed && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive sm:mr-auto"
              onClick={() => {
                setOpen(false);
                void actions.secret(webhook.id, null);
              }}
            >
              Remove signature
            </Button>
          )
        }
        onSubmit={(value) =>
          actions.secret(webhook.id, value.trim()).then(
            () => undefined,
            () => "Could not save",
          )
        }
      />
      <IconAction
        label="Delivery id header"
        tooltip={
          webhook.deliveryHeader ? `Delivery id · ${webhook.deliveryHeader}` : "Delivery id header"
        }
        icon={<FingerprintPatternIcon />}
        className="text-muted-foreground"
        onClick={() => setNaming(true)}
      />
      <NameDialog
        open={naming}
        onOpenChange={setNaming}
        title="Delivery id header"
        action="Save"
        label="Header"
        maxLength={100}
        required={false}
        initialName={webhook.deliveryHeader ?? ""}
        hint="Empty uses the usual headers."
        onSubmit={(value) =>
          actions.deliveryHeader(webhook.id, value.trim() || null).then(
            () => undefined,
            (err: unknown) => (err instanceof Error && err.message) || "Could not save",
          )
        }
      />
    </>
  );
}

function StopButton({ item }: { item: ActivityItem }) {
  const stop = useStopRun(item.work.subagent!.threadId);
  return (
    <IconAction
      label="Stop"
      icon={<SquareIcon className="size-3 fill-current" />}
      disabled={stop.isPending}
      onClick={() => stop.mutate()}
    />
  );
}

function CancelButton({ item }: { item: ActivityItem }) {
  const actions = useBackgroundActions();
  const [stopping, setStopping] = useState(false);
  if (!actions) return null;
  return (
    <IconAction
      label="Cancel"
      icon={<SquareIcon className="size-3 fill-current" />}
      disabled={stopping}
      onClick={() => {
        setStopping(true);
        void actions.cancel(item.rowId).finally(() => setStopping(false));
      }}
    />
  );
}

// The button that leads to the item's row in the transcript, when the loaded transcript has it.
function useGoToMessage(item: ActivityItem, threadId: string) {
  const here = useQuery(threadQuery(threadId)).data?.rows.some((row) => row.id === item.rowId);
  const go = useGoToRow(threadId);
  if (item.work.subagent || !here) return null;
  return (
    <IconAction label="Go to message" icon={<CornerUpLeftIcon />} onClick={() => go(item.rowId)} />
  );
}

function size(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

// What a schedule fired or a webhook took, newest first and a page at a time from the server, in a
// dialog, each with the way to its notification in the transcript. Read only once it is opened.
function FiredHistory({
  threadId,
  id,
  name,
  fired,
  webhook,
  onClose,
}: {
  threadId: string;
  id: string;
  name: string;
  fired: number;
  webhook: boolean;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const query = useQuery(
    firedHistoryQuery(threadId, webhook ? "webhook" : "schedule", id, offset, fired),
  );
  const history = query.data;
  const total = history?.total ?? fired;
  // The list keeps a page's height, so the dialog does not jump on a short last page or a load.
  const height = total > HISTORY_PAGE ? { minHeight: `${HISTORY_PAGE * 2}rem` } : undefined;
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent>
        <DialogHeader className="flex-row items-center justify-between gap-2 pr-8">
          <DialogTitle className="min-w-0 truncate">{name} history</DialogTitle>
          {history && (
            <PagerControl
              offset={history.offset}
              size={HISTORY_PAGE}
              total={history.total}
              onOffset={setOffset}
              before="Newer"
              after="Older"
            />
          )}
        </DialogHeader>
        {query.error && !history ? (
          <FieldError>Couldn't read the history.</FieldError>
        ) : history ? (
          history.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{webhook ? "No deliveries" : "No runs"}</p>
          ) : (
            <ul data-testid="fired-history" className="flex flex-col" style={height}>
              {history.entries.map((entry) => (
                <li key={entry.id}>
                  <RowLink
                    threadId={threadId}
                    rowId={entry.id}
                    onNavigate={onClose}
                    className={cn(
                      ROW,
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    )}
                  >
                    <span className="shrink-0 tabular-nums" title={fullTime(entry.at)}>
                      {stamp.format(new Date(entry.at))}
                    </span>
                    {entry.delivery && (
                      <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                        {[
                          entry.delivery.contentType ?? "No content type",
                          size(entry.delivery.bytes),
                          entry.delivery.signed ? "Signed" : "Unsigned",
                        ].join(" · ")}
                      </span>
                    )}
                  </RowLink>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex items-start justify-center" style={height}>
            <Spinner className="my-2 size-3.5" />
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// The line of the card: its mark, its name, what its kind says of it and where it stands, and its
// buttons, in one order for every kind: what is its own, the way to its message, pause, stop or
// delete.
function ItemRow({
  item,
  threadId,
  facts,
  onReview,
}: {
  item: ActivityItem;
  threadId: string;
  facts: string[];
  onReview: () => void;
}) {
  const { work } = item;
  const goTo = useGoToMessage(item, threadId);
  const set = work.schedule ?? work.webhook;
  const subagent = work.subagent;
  const review = item.attention === "approval";
  const [open, setOpen] = useState(false);
  const fired = work.webhook?.fired ?? work.schedule?.fired ?? 0;
  return (
    <li
      className={ROW}
      title={[item.by && `By ${item.by}`, ...facts].filter(Boolean).join(" · ") || undefined}
    >
      <Mark item={item} />
      {subagent ? (
        <Link to="/t/$threadId" params={{ threadId: subagent.threadId }} className={NAME}>
          {item.title}
        </Link>
      ) : (
        <RowLink threadId={threadId} rowId={item.rowId} className={NAME}>
          {item.title}
        </RowLink>
      )}
      {facts.length > 0 && (
        <span
          className="max-w-[40%] min-w-0 truncate text-xs text-muted-foreground"
          data-testid={subagent ? "subagent-context" : undefined}
        >
          {facts.join(" · ")}
        </span>
      )}
      <span className={`shrink-0 text-xs ${toneOf(item)}`}>
        <Detail item={item} />
      </span>
      <Group>
        {set && fired > 0 && (
          <WithTooltip label={`History · ${fired}`}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`History, ${work.webhook ? plural(fired, "delivery", "deliveries") : plural(fired, "run")}`}
              onClick={() => setOpen(true)}
            >
              <HistoryIcon />
            </Button>
          </WithTooltip>
        )}
        {review &&
          (subagent ? (
            <Link
              to="/t/$threadId"
              params={{ threadId: subagent.threadId }}
              search={subagent.waitingRow ? { row: subagent.waitingRow } : {}}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Review
            </Link>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={onReview}>
              Review
            </Button>
          ))}
        {work.webhook && <WebhookControls item={item} />}
        {goTo}
        {set?.canChange && <WorkControls work={work} id={set.id} name={item.title} />}
        {work.canCancel && (subagent ? <StopButton item={item} /> : <CancelButton item={item} />)}
      </Group>
      {open && set && fired > 0 && (
        <FiredHistory
          threadId={threadId}
          id={set.id}
          name={item.title}
          fired={fired}
          webhook={!!work.webhook}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  );
}

// A call waiting for a decision: the transcript's approval card, with the choices the server gives
// this reader, so it is decided here without going to its row.
function ApprovalCard({
  item,
  threadId,
  decide,
}: {
  item: ActivityItem;
  threadId: string;
  decide: (callId: string, allow: boolean, scope: ToolScope) => Promise<void>;
}) {
  const detail = useQuery(threadQuery(threadId)).data;
  const goTo = useGoToMessage(item, threadId);
  const row = detail?.rows.find((one) => one.id === item.rowId);
  if (!detail || row?.kind !== "tool" || row.state !== "waiting") return null;
  return (
    <div data-testid="tray-card" data-kind="decision" data-status="waiting">
      <ToolCard
        row={row}
        definition={detail.tools.find((tool) => tool.name === row.toolId)}
        decide={row.actions?.length ? (allow, scope) => decide(row.id, allow, scope) : undefined}
        menu={goTo}
      />
    </div>
  );
}

export function TrayItemCard({
  item,
  threadId,
  decide,
  onReview,
}: {
  item: ActivityItem;
  threadId: string;
  decide: (callId: string, allow: boolean, scope: ToolScope) => Promise<void>;
  // Opens the calls waiting for a decision.
  onReview: () => void;
}) {
  const { work } = item;
  if (work.kind === "decision")
    return <ApprovalCard item={item} threadId={threadId} decide={decide} />;
  const { schedule } = work;
  const { tasks } = work.subagent ?? {};
  const facts = [
    tasks && `${tasks.done}/${tasks.total} tasks`,
    schedule?.words &&
      `${schedule.words}${schedule.timezone && schedule.timezone !== "UTC" ? ` (${schedule.timezone})` : ""}`,
  ].filter((line): line is string => !!line);
  return (
    <div
      className="min-w-0"
      data-testid="tray-card"
      data-kind={work.kind}
      data-status={work.status}
    >
      <ul>
        <ItemRow item={item} threadId={threadId} facts={facts} onReview={onReview} />
      </ul>
    </div>
  );
}

// A kind's cards, a page at a time.
export function TrayList({
  items,
  ...rest
}: {
  items: ActivityItem[];
  threadId: string;
  decide: (callId: string, allow: boolean, scope: ToolScope) => Promise<void>;
  onReview: () => void;
}) {
  const { items: page, pager } = usePager(items);
  usePublishPager(pager);
  return (
    <div className="flex flex-col" style={pageHeight(pager)}>
      {page.map((item) => (
        <TrayItemCard key={item.rowId} item={item} {...rest} />
      ))}
    </div>
  );
}
