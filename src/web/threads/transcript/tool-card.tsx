// A tool call waiting for a decision: a card from the agent headed by the tool under a hand, tagged
// when the call asks each time, with the input and Allow, Allow for now and Deny in a row, enabled
// for the people who may run the tool and marked paused for everyone else.

import { cn } from "cn";
import { HandIcon } from "lucide-react";
import { useState } from "react";

import type { ToolRisk, ToolScope } from "@/shared/threads/events.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
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

// A tool call waiting for a decision: the tool's breadcrumb under the hand, its input, and the
// buttons to decide.
export function ToolCard({
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
