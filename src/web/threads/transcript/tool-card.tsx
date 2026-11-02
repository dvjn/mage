// A tool call waiting for a decision: a card from the agent headed by the tool under a hand, tagged
// when the call asks each time, with the input and Allow, Allow for now and Deny in a row, enabled
// for the people who may run the tool, marked paused for everyone else, and neither until that is
// known. Allow for now shows unless every call asks or needs review. A call that runs with its
// approver's own login asks an approver with no working connection to connect first, then applies
// their choice; a sign-in that leaves the page applies it on the way back.

import { cn } from "cn";
import { HandIcon } from "lucide-react";
import { useState } from "react";

import type { ToolRisk, ToolScope } from "@/shared/threads/events.ts";
import type { ToolConnection, ToolDefinition } from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import { ToolInput } from "@/web/agent/tool-value";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/web/components/ai-elements/confirmation";
import { Badge } from "@/web/components/ui/badge";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useConnectFlow } from "@/web/mcp/connect";
import { agentAvatar } from "@/web/threads/transcript/agent";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { ToolCrumb } from "@/web/threads/transcript/tool-crumb";

const ONLY_RUNNERS = "Only people who can run this here can decide";

// What a call's risk is called on its card; nothing for the usual one.
const RISK_TAGS: Partial<Record<ToolRisk, string>> = {
  ask: "Asks each time",
  review: "Needs review",
};

// The thread's page, saying which call to allow and how once the browser is back from signing in.
function allowingPath(callId: string, scope: ToolScope) {
  return `${window.location.pathname}?${new URLSearchParams({ allow: callId, scope })}`;
}

// A tool call waiting for a decision: the tool's breadcrumb under the hand, its input, and the
// buttons to decide.
export function ToolCard({
  row,
  definition,
  decide,
  connection,
  settling = false,
  continued,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  decide?: RowActions["decide"];
  // The reader's own connection, for a call that would run with it.
  connection?: ToolConnection;
  // Who may decide is not known yet, so the card is neither open nor paused.
  settling?: boolean;
  continued: boolean;
}) {
  const [deciding, setDeciding] = useState(false);
  // An approver with no working connection connects as they allow, and the call runs as them.
  const mustConnect = !!decide && !!connection && !connection.connected;
  const connect = useConnectFlow(mustConnect ? connection : undefined);
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
        disabled={!decide || deciding || connect.busy}
        onClick={() => {
          if (!decide) return;
          if (allow && mustConnect) {
            void connect.start(() => decide(allow, scope), allowingPath(row.id, scope));
            return;
          }
          setDeciding(true);
          void decide(allow, scope).finally(() => setDeciding(false));
        }}
      >
        {label}
      </ConfirmationAction>
    );
    if (decide || settling) return action;
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
      note={!decide && !settling && <span>Paused</span>}
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
            className={cn(
              "size-4 shrink-0",
              decide || settling ? "text-status-waiting" : "text-status-paused",
            )}
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
      {connect.dialog}
    </TranscriptRowFrame>
  );
}
