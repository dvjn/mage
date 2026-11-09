// A tool call as its state shows it: a card while it waits for a decision or for answers, the
// answers under its line once given, and otherwise its line. A subagent's waiting call shows as its
// card in the thread that started it too, headed by the subagent's name.

import { ASK_TOOL, askInputSchema } from "@/shared/ask.ts";
import type { AgentTurn, ToolRow } from "@/shared/threads/rows.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import { GivenAnswers } from "@/web/agent/question-form";
import { artifactOf } from "@/web/artifacts/call-artifacts";
import { ArtifactCard } from "@/web/artifacts/artifact-card";
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
  framed,
  subagent,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  decide?: RowActions["decide"];
  answer?: RowActions["answer"];
  turn: AgentTurn;
  // Inside a run of calls, which carries the turn's header and the indent.
  framed?: boolean;
  // The subagent whose call it is, when shown outside its thread.
  subagent?: string;
}) {
  const asked = row.toolId === ASK_TOOL ? askInputSchema.safeParse(row.input) : null;
  if (asked?.success && row.state === "pending" && row.waits) {
    return (
      <QuestionCard
        row={row}
        input={asked.data}
        answer={answer}
        continued={turn.continued}
        subagent={subagent}
      />
    );
  }
  if (asked?.success && row.answers) {
    const line = framed ? (
      <ToolLine row={row} definition={definition} framed />
    ) : turn.continued ? (
      <ToolLine row={row} definition={definition} />
    ) : (
      <ToolOpening row={row} definition={definition} turn={turn} />
    );
    return (
      <div className="flex flex-col gap-1">
        {line}
        <div className={framed ? undefined : "pl-9"}>
          <GivenAnswers input={asked.data} answers={row.answers} />
        </div>
      </div>
    );
  }
  if (row.state === "pending" && row.waits) {
    return (
      <ToolCard
        row={row}
        definition={definition}
        decide={decide}
        continued={turn.continued}
        subagent={subagent}
      />
    );
  }
  const artifact = artifactOf(row);
  const line = framed ? (
    <ToolLine row={row} definition={definition} framed />
  ) : !turn.continued ? (
    <ToolOpening row={row} definition={definition} turn={turn} />
  ) : (
    <ToolLine row={row} definition={definition} />
  );
  if (!artifact) return line;
  return (
    <div className="flex flex-col gap-1.5">
      {line}
      <ArtifactCard {...artifact} className={framed ? undefined : "ml-9"} />
    </div>
  );
}
