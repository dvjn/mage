// Each incoming message or notification is a received-message bubble. Short text is visible;
// longer text and task instructions expand in place. Source links remain available on hover.
import { Link } from "@tanstack/react-router";
import { BellIcon, BotIcon, ExternalLinkIcon } from "lucide-react";

import type { RelayRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { buttonVariants } from "@/web/components/ui/button";
import { Time } from "@/web/components/time";
import { RowToolbar } from "@/web/threads/transcript/row-history";
import { ActivityNotice } from "@/web/threads/transcript/activity-notice";
import { useThreadAgent } from "@/web/threads/transcript/agent";
import { RowLink } from "@/web/threads/transcript/row-focus";

interface Opened {
  opened: ReadonlySet<string>;
  onOpenChange: (ids: string[], open: boolean) => void;
}

export function RelayMessages({ rows, opened, onOpenChange }: { rows: RelayRow[] } & Opened) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {rows.map((row) => (
        <RelayMessage
          key={row.id}
          row={row}
          open={opened.has(row.id)}
          onOpenChange={(open) => onOpenChange([row.id], open)}
        />
      ))}
    </div>
  );
}

export function RelayMessage({
  row,
  open,
  onOpenChange,
}: {
  row: RelayRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { agentName } = useThreadAgent();
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
  // A message is titled by who sent it and opens on what it says. A notification about subagents
  // is told from its parts and opens on the subagent's last words; an older one, which has only
  // its text, shows that as it is.
  const title = message ? (
    <>
      {row.task ? "Task" : "Message"} from {agentLink(row.from.threadId, author)}
    </>
  ) : !named ? (
    text
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
  const body = message ? text : (row.last ?? "");
  // What the title says, as plain text, for copying: a notification's with what it opens on.
  const names = row.subagents?.map((one) => one.name).join(", ");
  const titleText = message
    ? text
    : !names
      ? text
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
  return (
    <ActivityNotice
      rowId={row.id}
      label={message ? `Message from ${author}` : "Notification"}
      source={
        message
          ? {
              name: author,
              kind: row.from.main ? "Agent" : "Subagent",
              mark: <BotIcon />,
              subtitle: row.to && `To ${row.to}`,
              facts: [{ label: "Sent", value: <Time iso={row.postedAt} /> }],
              open: renderSourceLink(true),
            }
          : {
              name: row.sentBy?.title ?? "System",
              kind: "System",
              mark: <BellIcon />,
              subtitle: row.sentBy?.toolset,
              facts: [
                ...(row.sentBy ? [{ label: "Thread", value: row.sentBy.thread }] : []),
                { label: "Sent", value: <Time iso={row.postedAt} /> },
              ],
              open: renderSourceLink(true),
            }
      }
      title={title}
      open={open}
      onOpenChange={onOpenChange}
      actions={<RowToolbar rowId={row.id} text={copied} extra={sourceLink} />}
    >
      {error && <p className="mb-2 text-sm break-words whitespace-pre-wrap">{error}</p>}
      {!!body && <MessageResponse>{body}</MessageResponse>}
      {row.task && (row.task.instructions || row.task.fork) && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
    </ActivityNotice>
  );
}
