// An agent's reply under its turn's Agent header, which names the model that wrote it: what the
// model thought first, folded away once it answers, then its Markdown with any layouts it wrote
// drawn in place; a reply that was cut short says so.

import type { AgentRow } from "@/shared/threads/rows.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/web/components/ai-elements/reasoning";
import { CopyButton } from "@/web/components/copy-button";
import { RichReply } from "@/web/replies/rich-reply";
import { AgentAvatar, useThreadAgent, caret, useModelName } from "@/web/threads/transcript/agent";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";

const ENDINGS: Partial<Record<AgentRow["status"], string>> = {
  interrupted: "Interrupted",
  failed: "Cut short",
};

// What the model thought, as a line the size of a tool call's that opens on it, folded away once
// the model answers.
export function ReplyReasoning({ row }: { row: AgentRow }) {
  return (
    <Reasoning
      isStreaming={row.status === "streaming" && !row.text}
      duration={row.thoughtMs === null ? undefined : Math.max(1, Math.ceil(row.thoughtMs / 1000))}
    >
      <ReasoningTrigger className="gap-1.5 py-0.5 text-xs [&>svg]:size-3.5" />
      <ReasoningContent className="mt-1">{row.reasoning}</ReasoningContent>
    </Reasoning>
  );
}

export function AgentReply({ row, continued }: { row: AgentRow; continued: boolean }) {
  const ending = ENDINGS[row.status];
  const streaming = row.status === "streaming";
  const model = useModelName(row.model);
  const { self } = useThreadAgent();
  return (
    <TranscriptRowFrame
      avatar={<AgentAvatar {...self} />}
      author={self.name}
      at={row.startedAt}
      label={`Message from ${self.name}`}
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
        {row.reasoning && <ReplyReasoning row={row} />}
        {!row.text ? (
          streaming && !row.reasoning && caret
        ) : (
          <RichReply
            text={row.text}
            streaming={streaming}
            markdown={(text, last) => (
              <MessageResponse isAnimating={streaming && last} caret="block">
                {text}
              </MessageResponse>
            )}
          />
        )}
      </div>
    </TranscriptRowFrame>
  );
}
