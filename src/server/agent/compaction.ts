// Compacting a thread for the agent: the earlier part of what it reads is set aside for a summary
// the thread's model writes, and the most recent part, about 20k tokens of it, is kept word for
// word; people still see the whole thread. The cut falls at a person's message with nothing before
// it still open: no run with rows on both sides of it and no call before it unsettled. The summary
// is written from the conversation as plain labelled lines, reasoning left out and what tools gave
// back cut short, and a later compaction writes its summary from the one before and what that one
// kept. Who wrote what is still read from the thread's rows, so a compaction changes nothing about
// whose words steered a call.

import type { ModelUsage } from "@/server/models/gateway.ts";
import type { OpenModel } from "@/server/models/service.ts";
import type { Actor, NewEvent } from "@/server/threads/service.ts";
import {
  asksToCompact,
  type CompactionRow,
  type ToolRow,
  type TranscriptRow,
} from "@/shared/transcript.ts";

// About how many tokens of the most recent conversation are kept word for word.
export const KEEP_TOKENS = 20_000;

// The most characters of what a tool gave back the summary is written from.
export const RESULT_CHARS = 2_000;

// About how many tokens the text is, at four characters to a token.
export function tokensOf(text: string) {
  return Math.ceil(text.length / 4);
}

function json(value: unknown) {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

// What a tool call gave back, as the agent reads it.
function resultOf(row: ToolRow) {
  if (row.output) return row.output.ok ? json(row.output.value) : `Error: ${row.output.error}`;
  if (row.state === "skipped") return "Skipped.";
  if (row.state === "pending" || row.state === "allowed") return null;
  return "Not run.";
}

// Whether the agent reads the reply: one finished, and not tried again.
function readReply(row: TranscriptRow) {
  return row.kind === "agent" && row.status !== "streaming" && !row.retried;
}

// About how many tokens of the row the agent reads.
function rowTokens(row: TranscriptRow) {
  switch (row.kind) {
    case "human":
      return asksToCompact(row) ? 0 : tokensOf(row.command?.text ?? row.text);
    case "agent":
      return readReply(row) ? tokensOf(row.text) : 0;
    case "tool":
      return tokensOf(json(row.input)) + tokensOf(resultOf(row) ?? "");
    default:
      return 0;
  }
}

// The thread's latest compaction, if any.
export function latestCompaction(rows: readonly TranscriptRow[]) {
  return rows.findLast((row): row is CompactionRow => row.kind === "compaction") ?? null;
}

// The index of the first row the agent reads word for word: the one its latest compaction kept
// from, or the first.
export function keptFrom(rows: readonly TranscriptRow[]) {
  const compaction = latestCompaction(rows);
  if (!compaction) return 0;
  const index = rows.findIndex((row) => row.seq >= compaction.firstKeptSeq);
  return index === -1 ? rows.length : index;
}

// What the agent reads of the thread: the summary of its latest compaction, if any, and the rows
// after that compaction's cut, compactions and requests for them left out.
export function readOf(rows: readonly TranscriptRow[]) {
  const compaction = latestCompaction(rows);
  const read = rows
    .slice(keptFrom(rows))
    .filter((row) => row.kind !== "compaction" && !(row.kind === "human" && asksToCompact(row)));
  return { summary: compaction?.summary ?? null, rows: read };
}

// Whether the agent reads the row as part of the conversation.
function inConversation(row: TranscriptRow) {
  if (row.kind === "human") return !asksToCompact(row);
  return row.kind === "tool" || readReply(row);
}

// Whether the agent reads anything word for word that a compaction could summarise.
export function anythingToCompact(rows: readonly TranscriptRow[]) {
  return rows.slice(keptFrom(rows)).some(inConversation);
}

function runOf(row: TranscriptRow) {
  return "runId" in row ? row.runId : null;
}

// Where the thread would be cut: the index of the first row kept, at a person's message with
// nothing before it still open, after some of the conversation since the latest compaction's cut.
// The earliest such place that keeps no more than `keep` tokens, else the latest; null when there
// is none, and so nothing to summarise.
export function cutOf(rows: readonly TranscriptRow[], keep = KEEP_TOKENS): number | null {
  const start = keptFrom(rows);
  // Where each run's rows begin and end, and so the places a run is under way across.
  const spans = new Map<string, [number, number]>();
  rows.forEach((row, index) => {
    const runId = runOf(row);
    if (!runId) return;
    const span = spans.get(runId);
    spans.set(runId, [span?.[0] ?? index, index]);
  });
  const across = Array.from({ length: rows.length + 1 }, () => 0);
  for (const [first, last] of spans.values()) {
    across[first + 1]! += 1;
    across[last + 1]! -= 1;
  }
  const kept = Array.from({ length: rows.length + 1 }, () => 0);
  for (let index = rows.length - 1; index >= 0; index--) {
    kept[index] = kept[index + 1]! + rowTokens(rows[index]!);
  }
  const places: number[] = [];
  let running = across[0]!;
  let unsettled = false;
  let content = false;
  for (let index = 1; index < rows.length; index++) {
    running += across[index]!;
    const before = rows[index - 1]!;
    if (before.kind === "tool" && resultOf(before) === null) unsettled = true;
    if (index - 1 >= start && inConversation(before)) content = true;
    const row = rows[index]!;
    if (!content || row.kind !== "human" || before.seq === row.seq) continue;
    if (running === 0 && !unsettled) places.push(index);
  }
  return places.find((index) => kept[index]! <= keep) ?? places.at(-1) ?? null;
}

// The conversation as the summary is written from it: each person's words, the agent's replies, its
// calls and what they gave back, as plain labelled lines.
export function conversationText(rows: readonly TranscriptRow[]) {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.kind === "human") {
      if (!asksToCompact(row)) lines.push(`[${row.author.name}]: ${row.command?.text ?? row.text}`);
    } else if (row.kind === "agent") {
      if (readReply(row) && row.text) lines.push(`[Agent]: ${row.text}`);
    } else if (row.kind === "tool") {
      lines.push(`[Agent called tool]: ${row.toolId} ${json(row.input)}`);
      const result = resultOf(row);
      if (result !== null) {
        const cut = result.length > RESULT_CHARS;
        lines.push(
          `[Tool result]: ${cut ? `${result.slice(0, RESULT_CHARS)} (cut short)` : result}`,
        );
      }
    }
  }
  return lines.join("\n");
}

export const SUMMARY_INSTRUCTIONS = [
  "You write the summary a conversation continues from once its earlier part is set aside. Several people talk with an AI agent in a shared thread; the agent reads your summary in place of the part it covers, then the rest of the conversation word for word.",
  "Write it in Markdown under these headings: Goal, Who asked for what, Decisions, Progress, Open questions, Key details.",
  "Name people as the conversation does. Keep exact names, numbers, paths and identifiers. Leave out what no longer matters. Write the summary alone, with nothing before or after it.",
].join("\n");

// What the summary is written from: the summary before, if any, the rows it covers, and the focus
// asked for.
export function summaryRequest(
  previous: string | null,
  rows: readonly TranscriptRow[],
  focus = "",
) {
  return [
    ...(previous ? [`The summary so far:\n${previous}`] : []),
    `${previous ? "The conversation since" : "The conversation"}:\n${conversationText(rows)}`,
    ...(focus ? [`Keep in particular: ${focus}`] : []),
  ].join("\n\n");
}

export interface Compacted {
  summary: string;
  firstKeptSeq: number;
  // How many rows the summary covers for the first time.
  summarised: number;
  tokensBefore: number;
  tokensAfter: number;
}

// Compacts the thread with the model: writes the summary and appends the compaction. Null, with
// nothing written, when there is nothing to summarise.
export async function compact(input: {
  threadId: string;
  rows: readonly TranscriptRow[];
  model: OpenModel;
  focus?: string;
  actor: Actor;
  write: <T>(work: (append: (event: NewEvent) => void) => T) => T;
  signal: AbortSignal;
}): Promise<Compacted | null> {
  const { threadId, rows, model, focus, actor, write, signal } = input;
  const at = cutOf(rows);
  if (at === null) return null;
  const from = keptFrom(rows);
  const previous = latestCompaction(rows)?.summary ?? null;
  const tokens = (start: number, end = rows.length) =>
    rows.slice(start, end).reduce((sum, row) => sum + rowTokens(row), 0);
  let text = "";
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  const stream = model.stream(
    {
      instructions: SUMMARY_INSTRUCTIONS,
      messages: [{ role: "user", text: summaryRequest(previous, rows.slice(from, at), focus) }],
      maxSteps: 1,
      sessionId: `${threadId}:compact`,
    },
    signal,
  );
  for await (const event of stream) {
    if (event.type === "delta") text += event.text;
    if (event.type === "step-end") {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
    }
  }
  const summary = text.trim();
  if (!summary) throw new Error("The model wrote no summary.");
  const done: Compacted = {
    summary,
    firstKeptSeq: rows[at]!.seq,
    summarised: at - from,
    tokensBefore: (previous ? tokensOf(previous) : 0) + tokens(from),
    tokensAfter: tokensOf(summary) + tokens(at),
  };
  const used = usage.inputTokens + usage.outputTokens > 0;
  write((append) =>
    append({
      type: "thread.compacted",
      actor,
      data: {
        summary,
        firstKeptSeq: done.firstKeptSeq,
        ...(focus && { focus }),
        tokensBefore: done.tokensBefore,
        tokensAfter: done.tokensAfter,
        ...(used && { usage }),
      },
    }),
  );
  return done;
}
