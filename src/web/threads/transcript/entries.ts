// How a thread's rows lay out in its transcript, as structure for the markup to space: turns, each
// a person's message, an incoming message or notice, an event, or the agent's turn; the agent's
// turn as blocks of reply text, cards and runs of lines, a line being a tool call's or the agent's
// thinking; and the turn's actions after it where its last step shows none. Two or more of the
// agent's calls in a row fold into one entry. A subagent's call that waits for a decision or for
// answers shows as its card right after the entry with the line that started the subagent.
// Received messages and notifications are turns of their own, outside the receiving agent's turn.

import { artifactOf, type CalledArtifact, cardsAfterReply } from "@/web/artifacts/call-artifacts";
import type {
  AgentRow,
  AgentTurn,
  NoticeRow,
  RelayRow,
  ShownRow,
  ToolRow,
} from "@/shared/threads/rows.ts";

// A row that shows on its own.
export type OwnRow = Exclude<ShownRow, RelayRow | NoticeRow>;

export type TranscriptEntry =
  | { kind: "row"; key: string; row: OwnRow }
  | {
      kind: "calls";
      // The run's first call, which stays its first as the run grows.
      key: string;
      // The calls and the steps that only thought between them, in order.
      rows: (ToolRow | AgentRow)[];
      calls: ToolRow[];
      turn: AgentTurn;
    }
  | {
      kind: "subagent";
      key: string;
      // The subagent's waiting call, and the subagent's thread and name.
      row: ToolRow;
      subagent: { threadId: string; name: string };
    }
  | {
      kind: "relays";
      // The run's first message, which stays its first as the run grows.
      key: string;
      rows: RelayRow[];
    }
  | { kind: "notice"; key: string; row: NoticeRow }
  | {
      // The artifacts a turn published or updated, as cards after its last row.
      kind: "artifacts";
      key: string;
      items: CalledArtifact[];
    };

// A part of the agent's turn: an entry on its own, or a run of lines, which sit closer together.
export type TranscriptBlock =
  | { kind: "lines"; key: string; entries: TranscriptEntry[] }
  | TranscriptEntry;

export interface TranscriptTurn {
  // The turn's first entry.
  key: string;
  // Who or what the turn is: the agent's, a person's message, something received, or an event
  // such as a failure or a stop.
  kind: "agent" | "human" | "incoming" | "event";
  blocks: TranscriptBlock[];
  // The step whose actions the finished turn shows after it, where its last step shows none.
  actions?: AgentRow;
}

// Whether a step of the agent's shows its own action bar: once written, when it answered, was cut
// short or has versions.
export function showsActions(row: AgentRow) {
  return (
    row.status !== "streaming" &&
    (!!row.text.trim() || row.status === "interrupted" || row.status === "failed" || !!row.versions)
  );
}

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

// Whether the entry is a line, a tool call's or the agent's thinking, and whether a line may follow
// it in the same run: answers given show under their call's line and end the run.
function line(entry: TranscriptEntry) {
  if (entry.kind === "calls") return { is: true, continues: true };
  if (entry.kind !== "row") return { is: false, continues: false };
  const { row } = entry;
  if (row.kind === "tool" && foldable(row)) return { is: true, continues: !row.answers };
  if (onlyThought(row)) return { is: true, continues: true };
  return { is: false, continues: false };
}

function turnOf(entry: TranscriptEntry) {
  if (entry.kind === "calls") return entry.turn;
  if (entry.kind === "row" && (entry.row.kind === "agent" || entry.row.kind === "tool"))
    return entry.row.turn ?? null;
  return null;
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
          },
        ]
      : [],
  );
}

// The entries the rows show as. Two or more of the agent's tool calls in a row, in one turn, with
// only steps that thought between them, fold into one; a call that waits as a card, or text, ends
// the run. A step that only called tools shows as its calls. Other agents' messages in a row fold
// into one, however many. Steps that neither wrote nor thought show as nothing, and incoming
// activity always ends the receiving agent's turn, even where cached rows still carry continuation
// metadata from before that rule.
export function transcriptEntries(rows: readonly ShownRow[]): TranscriptEntry[] {
  const shown = rows
    .filter((row) => row.kind !== "agent" || row.turn)
    .map((row, index, visible) => {
      const before = visible[index - 1];
      if (
        (row.kind === "agent" || row.kind === "tool") &&
        row.turn?.continued &&
        (before?.kind === "relay" || before?.kind === "notice")
      )
        return { ...row, turn: { ...row.turn, continued: false } };
      return row;
    });

  const entries: TranscriptEntry[] = [];
  let i = 0;
  while (i < shown.length) {
    const row = shown[i]!;
    if (row.kind === "relay") {
      const relays = [row];
      // Messages fold with messages, and other notifications with each other.
      const kin = (other: ShownRow | undefined): other is RelayRow =>
        other?.kind === "relay" &&
        (other.type === "message") === (row.type === "message") &&
        (row.type !== "message" || other.from.threadId === row.from.threadId);
      for (let later = shown[i + 1]; kin(later); later = shown[i + relays.length])
        relays.push(later);
      entries.push({ kind: "relays", key: `relays:${row.id}`, rows: relays });
      i += relays.length;
      continue;
    }
    if (row.kind === "notice") {
      entries.push({ kind: "notice", key: row.id, row });
      i++;
      continue;
    }
    if (!foldable(row)) {
      entries.push({ kind: "row", key: row.id, row });
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
      entries.push({ kind: "row", key: row.id, row });
      i++;
      continue;
    }
    entries.push({
      kind: "calls",
      key: `calls:${row.id}`,
      rows: members,
      calls,
      turn: row.turn ?? { continued: false, model: null },
    });
    i = next;
  }
  return entries.flatMap((entry) => [entry, ...subagentCards(entry)]);
}

// The rows as turns. A turn still running gets no actions.
export function transcriptTurns(
  rows: readonly ShownRow[],
  { running = false }: { running?: boolean } = {},
): TranscriptTurn[] {
  // The step each call was made in, which shows only through its calls when it neither wrote nor
  // thought.
  const stepOf = new Map<string, AgentRow>();
  let step: AgentRow | undefined;
  for (const row of rows) {
    if (row.kind === "agent") step = row;
    else if (row.kind === "tool" && step?.runId === row.runId) stepOf.set(row.id, step);
  }
  const groups: { kind: TranscriptTurn["kind"]; entries: TranscriptEntry[] }[] = [];
  for (const entry of transcriptEntries(rows)) {
    const current = groups.at(-1);
    const turn = turnOf(entry);
    if (current?.kind === "agent" && (entry.kind === "subagent" || turn?.continued)) {
      current.entries.push(entry);
      continue;
    }
    const kind = turn
      ? "agent"
      : entry.kind === "relays" || entry.kind === "notice"
        ? "incoming"
        : entry.kind === "row" && entry.row.kind === "human"
          ? "human"
          : "event";
    groups.push({ kind, entries: [entry] });
  }

  return groups.map((group, index) => {
    const turn: TranscriptTurn = {
      key: group.entries[0]!.key,
      kind: group.kind,
      blocks: [],
    };
    if (group.kind !== "agent") {
      turn.blocks = group.entries;
      return turn;
    }
    // Runs of lines group together; the rest stand as blocks of their own.
    let run: Extract<TranscriptBlock, { kind: "lines" }> | undefined;
    for (const entry of group.entries) {
      const shape = line(entry);
      if (!shape.is) {
        run = undefined;
        turn.blocks.push(entry);
        continue;
      }
      if (!run) {
        run = { kind: "lines", key: `lines:${entry.key}`, entries: [] };
        turn.blocks.push(run);
      }
      run.entries.push(entry);
      if (!shape.continues) run = undefined;
    }
    // A card for each artifact the turn made in a folded group of calls, where its card is out of
    // sight; a call that shows on its own line already shows its card there.
    const members: (ToolRow | AgentRow)[] = [];
    let tail: ToolRow | AgentRow | undefined;
    for (const entry of group.entries) {
      const own = entry.kind === "calls" ? entry.rows : entry.kind === "row" ? [entry.row] : [];
      for (const row of own) {
        if (row.kind !== "tool" && row.kind !== "agent") continue;
        tail = row;
        if (entry.kind === "row" && row.kind === "tool" && artifactOf(row)) continue;
        members.push(row);
      }
    }
    const items = cardsAfterReply(members);
    if (items.length > 0)
      turn.blocks.push({ kind: "artifacts", key: `artifacts:${turn.key}`, items });
    const last = tail && (tail.kind === "agent" ? tail : stepOf.get(tail.id));
    const ongoing = running && index === groups.length - 1;
    if (last && !showsActions(last) && last.status !== "streaming" && !ongoing) turn.actions = last;
    return turn;
  });
}
