// A tool call as its state shows it: a card while it waits for answers, the answers under its line
// once given, and otherwise its line, a call that waits for a decision included. A subagent's
// waiting question shows as its card in the thread that started it too, headed by the subagent's
// name.

import { ASK_TOOL, askInputSchema } from "@/shared/ask.ts";
import type { AgentTurn, ToolRow } from "@/shared/threads/rows.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import { GivenAnswers } from "@/web/agent/question-form";
import { artifactOf } from "@/web/artifacts/call-artifacts";
import { ArtifactCard } from "@/web/artifacts/artifact-card";
import { QuestionCard } from "@/web/threads/transcript/question-card";
import type { RowActions } from "@/web/threads/transcript/row-actions";
import { ToolLine } from "@/web/threads/transcript/tool-line";
import { ToolOpening } from "@/web/threads/transcript/tool-opening";

export function ToolCall({
  row,
  definition,
  answer,
  turn,
  framed,
  subagent,
  under,
  tools,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  // The calls under it at every depth, and the tools' definitions they show by.
  under?: readonly ToolRow[];
  tools?: readonly ToolDefinition[];
  answer?: RowActions["answer"];
  turn: AgentTurn;
  // Inside a run of calls, which carries the turn's header.
  framed?: boolean;
  // The subagent whose call it is, when shown outside its thread.
  subagent?: string;
}) {
  const asked = row.toolId === ASK_TOOL ? askInputSchema.safeParse(row.input) : null;
  if (asked?.success && row.state === "waiting") {
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
      <ToolLine row={row} definition={definition} under={under} tools={tools} />
    ) : turn.continued ? (
      <ToolLine row={row} definition={definition} under={under} tools={tools} />
    ) : (
      <ToolOpening row={row} definition={definition} turn={turn} under={under} tools={tools} />
    );
    return (
      <div className="flex flex-col gap-1">
        {line}
        <div>
          <GivenAnswers input={asked.data} answers={row.answers} />
        </div>
      </div>
    );
  }
  const artifact = artifactOf(row);
  const line = framed ? (
    <ToolLine row={row} definition={definition} under={under} tools={tools} />
  ) : !turn.continued ? (
    <ToolOpening row={row} definition={definition} turn={turn} under={under} tools={tools} />
  ) : (
    <ToolLine row={row} definition={definition} under={under} tools={tools} />
  );
  if (!artifact) return line;
  return (
    <div className="flex flex-col gap-1.5">
      {line}
      <ArtifactCard {...artifact} />
    </div>
  );
}
