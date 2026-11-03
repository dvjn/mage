// How a thread's rows lay out in its transcript: each row on its own, except a run of the agent's
// tool calls, which folds into one entry, and how far each entry sits from the one before. An
// agent's turn reads as one block, its lines close together and its reply text a little apart from
// them; only a new author or turn is set apart in full. A subagent's call that waits for a decision
// or for answers shows as its card right after the entry with the line that started the subagent.

import type { AgentRow, AgentTurn, ShownRow, ToolRow } from "@/shared/threads/rows.ts";

// How far an entry sits from the one before: a turn or author apart, close under a line of the
// same turn, or near where text or a card meets the rest of its turn.
export type EntryGap = "apart" | "close" | "near";

export type TranscriptEntry =
  | { kind: "row"; key: string; row: ShownRow; gap: EntryGap }
  | {
      kind: "calls";
      // The run's first call, which stays its first as the run grows.
      key: string;
      // The calls and the steps that only thought between them, in order.
      rows: (ToolRow | AgentRow)[];
      calls: ToolRow[];
      turn: AgentTurn;
      gap: EntryGap;
    }
  | {
      kind: "subagent";
      key: string;
      // The subagent's waiting call, and the subagent's thread and name.
      row: ToolRow;
      subagent: { threadId: string; name: string };
      gap: EntryGap;
    };

// A call that waits for a decision or for answers shows as a card of its own.
export function waitsAsCard(row: ToolRow) {
  return row.state === "pending" && row.waits;
}

// A step of the agent's that only thought: its reasoning, with no text.
function onlyThought(row: ShownRow): row is AgentRow {
  return row.kind === "agent" && !row.text && !!row.reasoning;
}

function foldable(row: ShownRow): row is ToolRow {
  return row.kind === "tool" && !waitsAsCard(row);
}

// Whether the entry starts and ends with a line, a tool call's or the agent's thinking, rather than
// text or a card.
function edges(entry: TranscriptEntry): { top: boolean; bottom: boolean } {
  if (entry.kind === "calls") return { top: true, bottom: true };
  if (entry.kind === "subagent") return { top: false, bottom: false };
  const { row } = entry;
  // Answers given show under their call's line.
  if (row.kind === "tool")
    return { top: !waitsAsCard(row), bottom: !waitsAsCard(row) && !row.answers };
  if (row.kind === "agent") {
    const writing = row.status === "streaming" && !row.text && !row.reasoning;
    return { top: !!row.reasoning, bottom: !row.text && !writing };
  }
  return { top: false, bottom: false };
}

function turnOf(entry: TranscriptEntry) {
  if (entry.kind === "subagent") return null;
  return entry.kind === "calls" ? entry.turn : entry.row.turn;
}

// The cards of the waiting calls of the subagents the entry's calls started.
function subagentCards(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind === "subagent") return [];
  const calls = entry.kind === "calls" ? entry.calls : entry.row.kind === "tool" ? [entry.row] : [];
  return calls.flatMap((call) =>
    call.subagent && call.subagentCall
      ? [
          {
            kind: "subagent" as const,
            key: `subagent:${call.subagentCall.id}`,
            row: call.subagentCall,
            subagent: { threadId: call.subagent.threadId, name: call.subagent.name },
            gap: "apart" as const,
          },
        ]
      : [],
  );
}

// The entries the rows show as. Two or more of the agent's tool calls in a row, in one turn, with
// only steps that thought between them, fold into one; a call that waits as a card, or text, ends
// the run. A step that only called tools shows as its calls.
export function transcriptEntries(rows: readonly ShownRow[]): TranscriptEntry[] {
  const shown = rows.filter((row) => row.kind !== "agent" || row.turn);
  const entries: TranscriptEntry[] = [];
  let i = 0;
  while (i < shown.length) {
    const row = shown[i]!;
    if (!foldable(row)) {
      entries.push({ kind: "row", key: row.id, row, gap: "apart" });
      i++;
      continue;
    }
    const members: (ToolRow | AgentRow)[] = [row];
    const calls = [row];
    let thoughts: AgentRow[] = [];
    let next = i + 1;
    for (let j = i + 1; j < shown.length; j++) {
      const later = shown[j]!;
      if (!later.turn?.continued) break;
      if (onlyThought(later)) {
        thoughts.push(later);
      } else if (foldable(later)) {
        members.push(...thoughts, later);
        calls.push(later);
        thoughts = [];
        next = j + 1;
      } else {
        break;
      }
    }
    if (calls.length < 2) {
      entries.push({ kind: "row", key: row.id, row, gap: "apart" });
      i++;
      continue;
    }
    entries.push({
      kind: "calls",
      key: `calls:${row.id}`,
      rows: members,
      calls,
      turn: row.turn ?? { continued: false, model: null },
      gap: "apart",
    });
    i = next;
  }
  const shownEntries = entries.flatMap((entry) => [entry, ...subagentCards(entry)]);
  shownEntries.forEach((entry, index) => {
    const before = shownEntries[index - 1];
    if (!before || !turnOf(entry)?.continued) return;
    entry.gap = edges(before).bottom && edges(entry).top ? "close" : "near";
  });
  return shownEntries;
}
