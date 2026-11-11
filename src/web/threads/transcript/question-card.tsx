// Questions a call puts to the thread: a card with the questions to answer or skip. A subagent's
// questions shown in the thread that started it are headed by the subagent's name.

import { cn } from "cn";
import { MessageCircleQuestionIcon } from "lucide-react";

import { type AskInput } from "@/shared/ask.ts";
import type { ToolRow } from "@/shared/threads/rows.ts";
import { QuestionForm } from "@/web/agent/question-form";
import { useThreadAgent } from "@/web/threads/transcript/agent";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { ToolCrumb } from "@/web/threads/transcript/tool-crumb";

// Questions a call puts to the thread, waiting for an answer: the tool's breadcrumb under a
// question mark, and the form to answer them.
export function QuestionCard({
  row,
  input,
  answer,
  continued,
  subagent,
}: {
  row: ToolRow;
  input: AskInput;
  answer?: RowActions["answer"];
  continued: boolean;
  // The subagent asking, when shown outside its thread.
  subagent?: string;
}) {
  const { self } = useThreadAgent();
  const who = subagent ? { name: subagent, subagent: true } : self;
  return (
    <TranscriptRowFrame
      rowId={row.id}
      author={who.name}
      at={row.requestedAt}
      label={`Questions from ${who.name}`}
      note={!answer && <span>Paused</span>}
      continued={continued}
    >
      <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <MessageCircleQuestionIcon
            aria-hidden
            className={cn("size-4 shrink-0", answer ? "text-status-waiting" : "text-status-paused")}
          />
          {subagent && <span className="shrink-0">{subagent} asks</span>}
          <ToolCrumb row={row} className="font-semibold" />
        </div>
        <QuestionForm input={input} answer={answer} />
      </div>
    </TranscriptRowFrame>
  );
}
