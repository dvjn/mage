// Compacting a thread for the agent: the earlier part of what it reads is set aside for a summary
// the thread's model writes, and the most recent part, about 20k tokens of it, is kept word for
// word; people still see the whole thread. The cut falls at a person's message with nothing before
// it still open: no run with rows on both sides of it and no call before it unsettled. The summary
// is asked for as the thread's own next request with the ask appended, so that the provider reads
// what its prompt cache holds of the thread's last turn: the same system prompt, tools, effort and
// messages, the kept part among them and named in the ask, which asks for no tool calls. When that
// request would not fit the model's context window, or the provider refuses it, or the model calls
// a tool or writes nothing, the summary is written from a prompt of its own: the conversation as
// plain labelled lines, reasoning left out and what tools gave back cut short. A later compaction
// builds on the summary before. Who wrote what is still read from the thread's rows, so a
// compaction changes nothing about whose words steered a call.

import { ModelError, type ModelRequest, type ModelUsage } from "@/server/models/gateway.ts";
import type { OpenModel } from "@/server/models/service.ts";
import type { Actor, NewEvent } from "@/server/threads/service.ts";
import { valueForAgent } from "@/shared/mcp.ts";
import {
  asksToCompact,
  type CompactionRow,
  type HumanRow,
  type ToolRow,
  type TranscriptRow,
} from "@/shared/transcript.ts";

import { noticeMessage, notificationLine } from "./context.ts";

// About how many tokens of the most recent conversation are kept word for word.
export const KEEP_TOKENS = 20_000;

// The most characters of what a tool gave back the summary is written from.
export const RESULT_CHARS = 2_000;

// The most of the model's context window the thread's own request may take to ask for the summary
// with; the rest allows for the estimate's error and the summary.
export const FITS_SHARE = 0.8;

// About how many tokens the text is, at four characters to a token.
export function tokensOf(text: string) {
  return Math.ceil(text.length / 4);
}

function json(value: unknown) {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

// What a tool call gave back, as the agent reads it.
function resultOf(row: ToolRow) {
  if (row.output) {
    return row.output.ok ? json(valueForAgent(row.output.value)) : `Error: ${row.output.error}`;
  }
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
    case "relay":
      return tokensOf(row.text);
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
  return row.kind === "tool" || row.kind === "relay" || readReply(row);
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
    } else if (row.kind === "relay") {
      lines.push(notificationLine(row));
    } else if (row.kind === "notice") {
      lines.push(noticeMessage(row).text);
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

// What the thread's next model call would send: its system prompt, messages, effort and tools.
export type ThreadRequest = Omit<ModelRequest, "model" | "maxSteps" | "beforeStep">;

// The ask appended to the thread's own request: what to summarise, up to the person's message the
// kept part starts with, if any, and how.
export function summaryAsk(input: {
  previous: boolean;
  kept: Pick<HumanRow, "author" | "text" | "command"> | null;
  focus?: string;
}) {
  const { previous, kept, focus = "" } = input;
  const words = kept ? (kept.command?.text ?? kept.text) : "";
  const excerpt = words.length > 200 ? `${words.slice(0, 200)}…` : words;
  return [
    "Write the summary this conversation continues from once its earlier part is set aside: from your next turn you read it in place of the part it covers, then the rest word for word.",
    kept
      ? `Summarise the conversation before the message of ${kept.author.name} that starts "${excerpt}". That message and all after it are kept word for word: leave them out.`
      : "Summarise the whole conversation.",
    ...(previous
      ? [
          "The conversation starts with the summary of an earlier part. Yours takes its place: carry over what still matters from it.",
        ]
      : []),
    "Write it in Markdown under these headings: Goal, Who asked for what, Decisions, Progress, Open questions, Key details.",
    "Name people as the conversation does. Keep exact names, numbers, paths and identifiers. Leave out your reasoning, and keep only what matters of what tools gave back. Leave out what no longer matters.",
    ...(focus ? [`Keep in particular: ${focus}`] : []),
    "Call no tools. Reply with the summary alone, with nothing before or after it.",
  ].join("\n");
}

// The thread's own request with the ask for the summary appended, for one model step. The ask
// names the person's message the kept part starts with, the first one the model reads.
export function compactionRequest(
  thread: ThreadRequest,
  rows: readonly TranscriptRow[],
  at: number,
  focus = "",
): Omit<ModelRequest, "model"> {
  const kept = rows
    .slice(at)
    .find((row): row is HumanRow => row.kind === "human" && !asksToCompact(row));
  const ask = summaryAsk({
    previous: latestCompaction(rows) !== null,
    kept: kept ?? null,
    focus,
  });
  return {
    ...thread,
    messages: [...thread.messages, { role: "user", text: ask }],
    maxSteps: 1,
    answerOnly: true,
  };
}

// Whether the request takes no more than its share of the model's context window, by its size;
// one to a model whose window is not known is sent, and the provider says if it does not fit.
export function fits(request: Omit<ModelRequest, "model">, contextWindow?: number) {
  if (!contextWindow) return true;
  const { instructions, messages, tools, searchable } = request;
  const size = tokensOf(instructions) + tokensOf(JSON.stringify([messages, tools, searchable]));
  return size <= contextWindow * FITS_SHARE;
}

// A failure the provider refused the request for, as one too long is, rather than the sign-in, a
// limit or the network.
function refused(err: unknown) {
  return !(err instanceof ModelError) || err.kind === "model";
}

// The summary the model writes for the request, adding the tokens it used to `usage`; null when it
// called a tool or wrote nothing.
async function summaryFrom(
  model: OpenModel,
  request: Omit<ModelRequest, "model">,
  usage: ModelUsage,
  signal: AbortSignal,
) {
  let text = "";
  let called = false;
  for await (const event of model.stream(request, signal)) {
    if (event.type === "delta") text += event.text;
    if (event.type === "tool-call") called = true;
    if (event.type === "step-end") {
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
    }
  }
  const summary = text.trim();
  return called || !summary ? null : summary;
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
// nothing written, when there is nothing to summarise. Given the thread's own request, it asks with
// that first.
export async function compact(input: {
  threadId: string;
  rows: readonly TranscriptRow[];
  model: OpenModel;
  request?: ThreadRequest;
  focus?: string;
  actor: Actor;
  write: <T>(work: (append: (event: NewEvent) => void) => T) => T;
  signal: AbortSignal;
}): Promise<Compacted | null> {
  const { threadId, rows, model, focus = "", actor, write, signal } = input;
  const at = cutOf(rows);
  if (at === null) return null;
  const from = keptFrom(rows);
  const previous = latestCompaction(rows)?.summary ?? null;
  const tokens = (start: number, end = rows.length) =>
    rows.slice(start, end).reduce((sum, row) => sum + rowTokens(row), 0);
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  let summary: string | null = null;
  const own = input.request && compactionRequest(input.request, rows, at, focus);
  if (own && fits(own, model.contextWindow)) {
    try {
      summary = await summaryFrom(model, own, usage, signal);
    } catch (err) {
      if (signal.aborted || !refused(err)) throw err;
    }
  }
  summary ??= await summaryFrom(
    model,
    {
      instructions: SUMMARY_INSTRUCTIONS,
      messages: [{ role: "user", text: summaryRequest(previous, rows.slice(from, at), focus) }],
      maxSteps: 1,
      sessionId: `${threadId}:compact`,
    },
    usage,
    signal,
  );
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
