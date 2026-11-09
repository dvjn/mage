// How a thread's rows lay out in its transcript: each row on its own, except a run of the agent's
// tool calls, which folds into one entry, and how far each entry sits from the one before. An
// agent's turn reads as one block, its lines close together and its reply text a little apart from
// them; only a new author or turn is set apart in full. A subagent's call that waits for a decision
// or for answers shows as its card right after the entry with the line that started the subagent.
// Notifications, a run of other agents' messages or of other notifications folded into one, and
// subagents that ended runs, as older threads were told, show as lines of the turn they follow,
// or open one.

import { artifactOf, type CalledArtifact, cardsAfterReply } from "@/web/artifacts/call-artifacts";
import type {
  AgentRow,
  AgentTurn,
  NoticeRow,
  RelayRow,
  ShownRow,
  ToolRow,
} from "@/shared/threads/rows.ts";

// How far an entry sits from the one before: a turn or author apart, close under a line of the
// same turn, or near where text or a card meets the rest of its turn.
export type EntryGap = "apart" | "close" | "near";

// A row that shows on its own.
export type OwnRow = Exclude<ShownRow, RelayRow | NoticeRow>;

export type TranscriptEntry =
  | { kind: "row"; key: string; row: OwnRow; gap: EntryGap }
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
    }
  | {
      kind: "relays";
      // The run's first message, which stays its first as the run grows.
      key: string;
      rows: RelayRow[];
      turn: AgentTurn;
      gap: EntryGap;
    }
  | { kind: "notice"; key: string; row: NoticeRow; turn: AgentTurn; gap: EntryGap }
  | {
      // The artifacts a turn published or updated, as cards after its last row.
      kind: "artifacts";
      key: string;
      items: CalledArtifact[];
      turn: AgentTurn;
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
  if (entry.kind === "artifacts") return { top: false, bottom: false };
  if (entry.kind === "calls" || entry.kind === "relays" || entry.kind === "notice")
    return { top: true, bottom: true };
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
  return entry.kind === "row" ? entry.row.turn : entry.turn;
}

// The cards of the waiting calls of the subagents the entry's calls started.
function subagentCards(entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.kind !== "calls" && entry.kind !== "row") return [];
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

// After the last entry of each of the agent's turns, a card for each artifact the turn made in a
// folded group of calls, where its card is out of sight.
function withArtifactCards(entries: TranscriptEntry[]): TranscriptEntry[] {
  const result: TranscriptEntry[] = [];
  let members: (ToolRow | AgentRow)[] = [];
  let last: TranscriptEntry | undefined;
  const close = () => {
    const items = cardsAfterReply(members);
    members = [];
    if (!last || items.length === 0) return;
    result.push({
      kind: "artifacts",
      key: `artifacts:${last.key}`,
      items,
      turn: { continued: true, model: null },
      gap: "near",
    });
  };
  for (const entry of entries) {
    if (entry.kind === "subagent") {
      result.push(entry);
      continue;
    }
    if (!turnOf(entry)?.continued) {
      close();
      last = undefined;
    }
    const rows = entry.kind === "calls" ? entry.rows : entry.kind === "row" ? [entry.row] : [];
    for (const row of rows) {
      if (row.kind !== "tool" && row.kind !== "agent") continue;
      // A call that shows on its own line already shows its card there.
      if (entry.kind === "row" && row.kind === "tool" && artifactOf(row)) continue;
      members.push(row);
    }
    if (turnOf(entry)) last = entry;
    result.push(entry);
  }
  close();
  return result;
}

// The entries the rows show as. Two or more of the agent's tool calls in a row, in one turn, with
// only steps that thought between them, fold into one; a call that waits as a card, or text, ends
// the run. A step that only called tools shows as its calls. Other agents' messages in a row fold
// into one, however many.
export function transcriptEntries(rows: readonly ShownRow[]): TranscriptEntry[] {
  const shown = rows.filter((row) => row.kind !== "agent" || row.turn);
  const entries: TranscriptEntry[] = [];
  // Whether a relay or notice continues a turn is known once the entry before it is.
  const opening = { continued: false, model: null };
  let i = 0;
  while (i < shown.length) {
    const row = shown[i]!;
    if (row.kind === "relay") {
      const relays = [row];
      // Messages fold with messages, and other notifications with each other.
      const kin = (other: ShownRow | undefined): other is RelayRow =>
        other?.kind === "relay" && (other.type === "message") === (row.type === "message");
      for (let later = shown[i + 1]; kin(later); later = shown[i + relays.length])
        relays.push(later);
      entries.push({
        kind: "relays",
        key: `relays:${row.id}`,
        rows: relays,
        turn: opening,
        gap: "apart",
      });
      i += relays.length;
      continue;
    }
    if (row.kind === "notice") {
      entries.push({ kind: "notice", key: row.id, row, turn: opening, gap: "apart" });
      i++;
      continue;
    }
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
  const shownEntries = withArtifactCards(
    entries.flatMap((entry) => [entry, ...subagentCards(entry)]),
  );
  shownEntries.forEach((entry, index) => {
    const before = shownEntries[index - 1];
    if ((entry.kind === "relays" || entry.kind === "notice") && before) {
      const turn = turnOf(before);
      entry.turn = { continued: !!turn, model: turn?.model ?? null };
    }
    if (!before || !turnOf(entry)?.continued) return;
    entry.gap = edges(before).bottom && edges(entry).top ? "close" : "near";
  });
  return shownEntries;
}
