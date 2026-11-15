// Each incoming message or notification is a card on the right, built on the shared card frame: a
// header line, and a body that opens in place. What an agent says opens expanded; the rest start
// closed. The source is available from the avatar and, on hover, a link.
import { Link } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  CalendarClockIcon,
  ClockIcon,
  ExternalLinkIcon,
  ListChecksIcon,
  WebhookIcon,
  WrenchIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { meQuery } from "@/web/auth/queries";

import type { NoticeRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { buttonVariants } from "@/web/components/ui/button";
import { Time } from "@/web/components/time";
import { RowToolbar } from "@/web/threads/transcript/row-history";
import { CardFrame } from "@/web/threads/transcript/card-frame";
import { NoticeFrame } from "@/web/threads/transcript/notice-frame";
import { useThreadAgent } from "@/web/threads/transcript/agent";
import { fenced, payloadOf, sizeText } from "@/web/threads/transcript/notice-details";
import { initialsOf } from "@/web/lib/initials";
import { RowLink } from "@/web/threads/transcript/row-focus";
import { ToolCard } from "@/web/threads/transcript/tool-card";
import { ChangeTitle } from "@/web/threads/transcript/change-title";
import { Crumb } from "@/web/threads/transcript/tool-crumb";
import { OWN_MARK, type Source } from "@/web/threads/transcript/source-card";

interface Opened {
  opened: ReadonlySet<string>;
  onOpenChange: (ids: string[], open: boolean) => void;
}

export function NoticeMessages({ rows, opened, onOpenChange }: { rows: NoticeRow[] } & Opened) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows.map((row) => (
        <NoticeMessage
          key={row.id}
          row={row}
          open={opened.has(row.id)}
          onOpenChange={(open) => onOpenChange([row.id], open)}
        />
      ))}
    </div>
  );
}

// What each notification of the activity tray's items is shown with.
const TRAY: Partial<Record<NoticeRow["type"], { kind: string; mark: ReactNode }>> = {
  "webhook.received": { kind: "Webhook", mark: <WebhookIcon /> },
  "schedule.fired": { kind: "Schedule", mark: <CalendarClockIcon /> },
  "call.ended": { kind: "Job", mark: <WrenchIcon /> },
  "task.changed": { kind: "Tasks", mark: <ListChecksIcon /> },
};

// What an outside or system event is shown with, by its kind.
const SOURCES: Record<
  Extract<NonNullable<NoticeRow["actor"]>, { kind: "source" }>["type"],
  { kind: string; mark: ReactNode }
> = {
  webhook: { kind: "Webhook", mark: <WebhookIcon /> },
  schedule: { kind: "Schedule", mark: <ClockIcon /> },
  wakeup: { kind: "Wake-up", mark: <ClockIcon /> },
  job: { kind: "Job", mark: <WrenchIcon /> },
  system: { kind: "System", mark: <BellIcon /> },
};

// What a change someone made is shown with, by the kind of item it was made to.
const CHANGED = {
  tasks: TRAY["task.changed"]!,
  schedules: TRAY["schedule.fired"]!,
  webhooks: TRAY["webhook.received"]!,
} satisfies Record<NonNullable<NoticeRow["tray"]>, { kind: string; mark: ReactNode }>;

// What a webhook's post was: its payload as a code block that scrolls, and what is known of it.
function Delivery({ row }: { row: NoticeRow }) {
  const payload = payloadOf(row);
  const facts: [string, ReactNode][] = [];
  if (payload.contentType) facts.push(["Content type", payload.contentType]);
  if (row.delivery) {
    facts.push(["Size", sizeText(row.delivery.bytes)]);
    facts.push(["Signature", row.delivery.signed ? "Signed" : "Unsigned"]);
  }
  return (
    <>
      {payload.text && (
        <div className="max-h-64 overflow-auto rounded-md">
          <MessageResponse>{fenced(payload.text, payload.language)}</MessageResponse>
        </div>
      )}
      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

export function NoticeMessage({
  row,
  open,
  onOpenChange,
}: {
  row: NoticeRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { agentName } = useThreadAgent();
  const me = useQuery(meQuery);
  const message = row.type === "message";
  const author = row.from.main ? agentName : row.from.name;
  const text = row.text;
  // A link to an agent's thread, by its name.
  const agentLink = (threadId: string, name: string) => (
    <Link
      key={threadId}
      to="/t/$threadId"
      params={{ threadId }}
      className="font-medium underline-offset-2 hover:underline"
    >
      {name}
    </Link>
  );
  const named = row.subagents?.map((one, index) => (
    <span key={one.threadId}>
      {index > 0 && ", "}
      {agentLink(one.threadId, one.name)}
    </span>
  ));
  const webhook = row.type === "webhook.received";
  const fired = row.type === "schedule.fired";
  const wake = fired && row.text.startsWith("Wake-up");
  const ending = row.type.startsWith("agent.");
  // A message is titled by who sent it and opens on what it says. A notification about subagents
  // is told from its parts and opens on the subagent's last words; an older one, which has only
  // its text, shows that as it is.
  const tray = row.type === "change" ? row.tray && CHANGED[row.tray] : TRAY[row.type];
  const title = message ? (
    <>
      {row.task ? "Task" : "Message"} from {agentLink(row.from.threadId, author)}
    </>
  ) : !named ? (
    row.text
  ) : row.type === "agent.idle" ? (
    <>
      {row.when === "all_idle" ? "All idle" : "Idle"}: {named}
    </>
  ) : row.type === "agent.failed" ? (
    <>{named} failed</>
  ) : row.type === "agent.stopped" ? (
    <>{named} was stopped</>
  ) : (
    <>{named} ended its run without reporting</>
  );
  // What the title says, as plain text, for copying: a notification's with what it opens on.
  const names = row.subagents?.map((one) => one.name).join(", ");
  const titleText = message
    ? text
    : webhook
      ? `Webhook › ${row.from.name}`
      : fired
        ? wake
          ? "Wake-up"
          : `Schedule › ${row.from.name}`
        : !names
          ? row.text
          : row.type === "agent.idle"
            ? `${row.when === "all_idle" ? "All idle" : "Idle"}: ${names}`
            : row.type === "agent.failed"
              ? `${names} failed`
              : row.type === "agent.stopped"
                ? `${names} was stopped`
                : `${names} ended its run without reporting`;
  const error = row.type === "agent.failed" ? row.error : undefined;
  const copied = message ? text : [titleText, error, row.last].filter(Boolean).join("\n\n");
  const link = row.sentBy ?? row.source;
  const sourceName = row.sentBy
    ? [row.sentBy.toolset, row.sentBy.title].filter(Boolean).join(" › ")
    : author;
  function renderSourceLink(full = false) {
    const content = (
      <>
        <ExternalLinkIcon aria-hidden />
        {full ? (
          <span>{link ? "Open source" : "Open thread"}</span>
        ) : (
          <span className="sr-only">Open source: {sourceName}</span>
        )}
      </>
    );
    const className = buttonVariants({
      variant: full ? "outline" : "ghost",
      size: full ? "xs" : "icon-xs",
    });
    return link ? (
      <RowLink threadId={link.threadId} rowId={link.rowId} className={className}>
        {content}
      </RowLink>
    ) : (
      message && (
        <Link to="/t/$threadId" params={{ threadId: row.from.threadId }} className={className}>
          {content}
        </Link>
      )
    );
  }
  const sourceLink = renderSourceLink();
  const base: Source = message
    ? {
        name: author,
        kind: row.from.main ? "Agent" : "Subagent",
        mark: <BotIcon />,
        subtitle: row.to && `To ${row.to}`,
        facts: [{ label: "Sent", value: <Time iso={row.postedAt} /> }],
        open: renderSourceLink(true),
      }
    : {
        name:
          row.type === "change" || (tray && row.type !== "call.ended")
            ? row.from.name
            : (row.sentBy?.title ?? "System"),
        kind: tray?.kind ?? (row.type === "change" ? "Thread" : "System"),
        mark: tray?.mark ?? <BellIcon />,
        subtitle: row.sentBy?.toolset,
        facts: [
          ...(row.sentBy ? [{ label: "Thread", value: row.sentBy.thread }] : []),
          { label: "Sent", value: <Time iso={row.postedAt} /> },
        ],
        open: renderSourceLink(true),
      };
  // The avatar is the actor's, where the notification says who: a person's initials, an agent's
  // mark, or the kind of outside event.
  const { actor } = row;
  const actorName =
    actor?.kind === "agent" && actor.main
      ? agentName
      : actor && "name" in actor
        ? actor.name
        : undefined;
  const source: Source = !actor
    ? base
    : actor.kind === "person"
      ? {
          ...base,
          name: actor.name,
          // The reader's own actions are marked as their messages are.
          ...(actor.userId === me.data?.user.id
            ? { kind: "You", markClassName: OWN_MARK }
            : { kind: "Member" }),
          mark: initialsOf(actor.name),
        }
      : actor.kind === "agent"
        ? { ...base, name: actorName!, kind: actor.main ? "Agent" : "Subagent", mark: <BotIcon /> }
        : { ...base, name: actor.label, ...SOURCES[actor.type] };
  // What the notification says leads with the actor's name when they made it, which the avatar and
  // name beside it say already.
  const lead = actorName && typeof title === "string" && title.startsWith(`${actorName} `);
  const shownTitle = lead ? title.slice(actorName!.length + 1) : title;
  // A card that starts open holds, among the rows the reader opened, the ones they closed.
  const startsOpen = message;
  const shownOpen = startsOpen ? !open : open;
  const setOpen = (next: boolean) => onOpenChange(startsOpen ? !next : next);
  const toolbar = <RowToolbar rowId={row.id} text={copied} extra={sourceLink} />;
  const label = message ? `Message from ${author}` : "Notice";
  if (row.ran) {
    return (
      <NoticeFrame rowId={row.id} label={label} source={source} actions={toolbar}>
        <ToolCard
          row={{ ...row.ran, order: row.order, turn: null }}
          definition={undefined}
          finished
          open={shownOpen}
          onOpenChange={setOpen}
        />
      </NoticeFrame>
    );
  }
  // What the card opens on: a webhook's post, when a schedule goes off and its note, or what an
  // agent said. A change to tasks and the like is its header line alone.
  const said = message || ending ? (message ? text : (row.last ?? "")) : "";
  const payload = webhook ? payloadOf(row) : undefined;
  const delivered = !!payload && !!(payload.text || payload.contentType || row.delivery);
  const parent = webhook
    ? "Webhook"
    : fired
      ? wake
        ? undefined
        : "Schedule"
      : row.type === "task.changed" || row.type === "change"
        ? tray?.kind
        : undefined;
  const name = webhook || (fired && !wake) ? row.from.name : wake ? "Wake-up" : shownTitle;
  const icon = wake ? (
    <ClockIcon />
  ) : message || ending ? (
    <BotIcon />
  ) : (
    (tray?.mark ?? <BellIcon />)
  );
  return (
    <NoticeFrame rowId={row.id} label={label} source={source} actions={toolbar}>
      <CardFrame
        icon={icon}
        title={
          row.change ? (
            <ChangeTitle change={row.change} parent={parent} />
          ) : (
            <Crumb parent={parent}>{name}</Crumb>
          )
        }
        status={
          webhook
            ? { label: "Delivered" }
            : message
              ? { label: row.from.main ? "Agent" : "Subagent" }
              : undefined
        }
        open={shownOpen}
        onOpenChange={setOpen}
        body={message || ending ? "text" : "details"}
      >
        {error && <p className="text-sm break-words whitespace-pre-wrap">{error}</p>}
        {delivered && <Delivery row={row} />}
        {fired && (!!row.schedule || !!row.last) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {row.schedule && (
              <>
                <dt>Schedule</dt>
                <dd>{row.schedule}</dd>
              </>
            )}
            {!!row.last && (
              <>
                <dt>Note</dt>
                <dd className="whitespace-pre-wrap">{row.last}</dd>
              </>
            )}
          </dl>
        )}
        {!!said && <MessageResponse>{said}</MessageResponse>}
        {row.task && (row.task.instructions || row.task.fork) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {row.task.instructions && (
              <>
                <dt>Instructions</dt>
                <dd className="whitespace-pre-wrap">{row.task.instructions}</dd>
              </>
            )}
            {row.task.fork && (
              <>
                <dt>Context</dt>
                <dd>A copy of {row.from.name}</dd>
              </>
            )}
          </dl>
        )}
      </CardFrame>
    </NoticeFrame>
  );
}
