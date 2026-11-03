// A tool call as its state shows it: a card while it waits for a decision or for answers, the
// answers under its line once given, and otherwise its line.

import { ASK_TOOL, askInputSchema } from "@/shared/ask.ts";
import type { AgentTurn, ToolRow } from "@/shared/threads/rows.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import { GivenAnswers } from "@/web/agent/question-form";
import { QuestionCard } from "@/web/threads/transcript/question-card";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { ToolCard } from "@/web/threads/transcript/tool-card";
import { ToolLine } from "@/web/threads/transcript/tool-line";
import { ToolOpening } from "@/web/threads/transcript/tool-opening";

export function ToolCall({
  row,
  definition,
  decide,
  answer,
  turn,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  decide?: RowActions["decide"];
  answer?: RowActions["answer"];
  turn: AgentTurn;
}) {
  const asked = row.toolId === ASK_TOOL ? askInputSchema.safeParse(row.input) : null;
  if (asked?.success && row.state === "pending" && row.waits) {
    return <QuestionCard row={row} input={asked.data} answer={answer} continued={turn.continued} />;
  }
  if (asked?.success && row.answers) {
    const line = turn.continued ? (
      <ToolLine row={row} definition={definition} />
    ) : (
      <ToolOpening row={row} definition={definition} turn={turn} />
    );
    return (
      <div className="flex flex-col gap-1">
        {line}
        <div className="pl-9">
          <GivenAnswers input={asked.data} answers={row.answers} />
        </div>
      </div>
    );
  }
  if (row.state === "pending" && row.waits) {
    return (
      <ToolCard row={row} definition={definition} decide={decide} continued={turn.continued} />
    );
  }
  if (!turn.continued) return <ToolOpening row={row} definition={definition} turn={turn} />;
  return <ToolLine row={row} definition={definition} />;
}
