// The agent's row while a run has started but no words have arrived yet, or while it compacts the
// thread.

import { Spinner } from "@/web/components/ui/spinner";
import { agentAvatar, caret } from "@/web/threads/transcript/agent";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";

// The agent's row while a run has started but no words have arrived yet, or while it writes the
// summary that compacts the thread; continued when it follows the agent's own rows.
export function AgentStarting({
  at,
  continued,
  compacting,
}: {
  at: string;
  continued?: boolean;
  compacting?: boolean;
}) {
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={at}
      label="Message from Agent"
      continued={continued}
    >
      {compacting ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" aria-hidden />
          <span>Compacting…</span>
        </div>
      ) : (
        <div className="flex text-sm" aria-busy>
          {caret}
        </div>
      )}
    </TranscriptRowFrame>
  );
}
