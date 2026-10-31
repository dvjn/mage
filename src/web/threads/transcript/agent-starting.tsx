// The agent's row while a run has started but no words have arrived yet.

import { agentAvatar, caret } from "@/web/threads/transcript/agent";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";

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
