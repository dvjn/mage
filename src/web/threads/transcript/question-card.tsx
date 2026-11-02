// Questions a call puts to the thread: a card with the questions to answer or skip.

import { cn } from "cn";
import { MessageCircleQuestionIcon } from "lucide-react";

import { type AskInput } from "@/shared/ask.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import { QuestionForm } from "@/web/agent/question-form";
import { agentAvatar } from "@/web/threads/transcript/agent";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { ToolCrumb } from "@/web/threads/transcript/tool-crumb";

// Questions a call puts to the thread, waiting for an answer: the tool's breadcrumb under a
// question mark, and the form to answer them.
export function QuestionCard({
  row,
  input,
  definition,
  answer,
  settling = false,
  continued,
}: {
  row: ToolRow;
  input: AskInput;
  definition: ToolDefinition | undefined;
  answer?: RowActions["answer"];
  // Who may answer is not known yet, so the card is neither open nor paused.
  settling?: boolean;
  continued: boolean;
}) {
  return (
    <TranscriptRowFrame
      avatar={agentAvatar}
      author="Agent"
      at={row.requestedAt}
      label="Questions from Agent"
      note={!answer && !settling && <span>Paused</span>}
      continued={continued}
    >
      <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <MessageCircleQuestionIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0",
              answer || settling ? "text-status-waiting" : "text-status-paused",
            )}
          />
          <ToolCrumb row={row} definition={definition} className="font-semibold" />
        </div>
        <QuestionForm input={input} answer={answer} />
      </div>
    </TranscriptRowFrame>
  );
}
