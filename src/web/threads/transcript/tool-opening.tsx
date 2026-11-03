// A tool call that opens the agent's turn, under the Agent header.

import type { ToolDefinition } from "@/shared/tools.ts";
import type { AgentTurn, ToolRow } from "@/shared/threads/rows.ts";
import { AgentAvatar, useThreadAgent, useModelName } from "@/web/threads/transcript/agent";
import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { ToolLine } from "@/web/threads/transcript/tool-line";

// A tool call that opens the agent's turn: the Agent header, naming the model the turn's reply was
// written with, over the call's line.
export function ToolOpening({
  row,
  definition,
  turn,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  turn: AgentTurn;
}) {
  const model = useModelName(turn.model);
  const { self } = useThreadAgent();
  return (
    <TranscriptRowFrame
      avatar={<AgentAvatar {...self} />}
      author={self.name}
      at={row.requestedAt}
      label={`Message from ${self.name}`}
      note={model && <span>{model}</span>}
    >
      <ToolLine row={row} definition={definition} framed />
    </TranscriptRowFrame>
  );
}
