// What the agent is given to reply from: a short system prompt naming Mage and the people in the
// thread, followed by the org's instructions, the space's, what Mage's own toolsets on there tell
// it and the skills on there, when there are any, and the thread's messages in the order the agent
// saw them, each person's prefixed with their name, each reply with the tool calls it asked for and
// what they gave back. Quiet asides are included; replies still being written, and replies cut
// short that were tried again, are not. A call that did not run gives back only that it was not
// approved, or that its questions were skipped.

import type { ModelMessage, ModelToolResult } from "@/ports/model-gateway.ts";
import { QUIET_PREFIX } from "@/shared/threads.ts";
import type { HumanRow, ToolRow, TranscriptRow } from "@/shared/transcript.ts";

export interface Context {
  instructions: string;
  messages: ModelMessage[];
}

export function humanMessage(row: Pick<HumanRow, "author" | "text">): ModelMessage {
  return { role: "user", text: `[${row.author.name}] ${row.text}` };
}

// What the org and the space tell the agent, and the skills it may load there.
export interface Guidance {
  org: string;
  space: string;
  skills?: { name: string; description: string }[];
  // What Mage's own toolsets on in the space tell it.
  toolsets?: string[];
}

export const NO_GUIDANCE: Guidance = { org: "", space: "" };

export function instructionsFor(people: string[], guidance: Guidance = NO_GUIDANCE) {
  const sections = [
    [
      "You are the agent in Mage, a workspace where people talk with you and with each other in shared threads.",
      `The people in this thread: ${people.join(", ")}.`,
      "Each of their messages starts with the writer's name in brackets, like [Ada Lovelace]. Your replies do not start with a name.",
      `A message starting with ${QUIET_PREFIX} is an aside between people: take it in as context, but do not answer it.`,
      "Reply in Markdown.",
    ].join("\n"),
  ];
  if (guidance.org.trim()) {
    sections.push(`Instructions from the organization:\n${guidance.org.trim()}`);
  }
  if (guidance.space.trim()) {
    sections.push(`Instructions from this space:\n${guidance.space.trim()}`);
  }
  for (const text of guidance.toolsets ?? []) sections.push(text);
  if (guidance.skills?.length) {
    sections.push(
      [
        "Skills you can load: instructions for particular kinds of tasks. When a task matches a skill's description, load it with the load skill tool before you start, and read its files only as you need them.",
        ...guidance.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

export const NOT_APPROVED = "This action was not approved.";

// What a settled call gave back; null while it is still to be decided or run.
function resultOf(row: ToolRow): ModelToolResult | null {
  const { id: callId, toolId } = row;
  switch (row.state) {
    case "pending":
    case "allowed":
      return null;
    case "ran":
    case "failed":
      return row.output && { callId, toolId, output: row.output };
    case "skipped":
      return { callId, toolId, output: { ok: true, value: { skipped: true } } };
    default:
      return { callId, toolId, output: { ok: false, error: NOT_APPROVED } };
  }
}

export function contextOf(
  rows: readonly TranscriptRow[],
  guidance: Guidance = NO_GUIDANCE,
): Context {
  const people = new Set<string>();
  const messages: ModelMessage[] = [];
  const calls = new Map<string, ToolRow[]>();
  for (const row of rows) {
    if (row.kind !== "tool") continue;
    calls.set(row.messageId, [...(calls.get(row.messageId) ?? []), row]);
  }
  for (const row of rows) {
    if (row.kind === "human") {
      people.add(row.author.name);
      messages.push(humanMessage(row));
    } else if (row.kind === "agent" && row.status !== "streaming" && !row.retried) {
      const settled = (calls.get(row.id) ?? [])
        .map((call) => ({ call, result: resultOf(call) }))
        .filter((settled) => settled.result !== null);
      if (!row.text && settled.length === 0) continue;
      messages.push({
        role: "assistant",
        text: row.text,
        ...(settled.length > 0 && {
          toolCalls: settled.map(({ call }) => ({
            callId: call.id,
            toolId: call.toolId,
            input: call.input,
          })),
        }),
      });
      if (settled.length > 0) {
        messages.push({ role: "tool", results: settled.map(({ result }) => result!) });
      }
    }
  }
  return { instructions: instructionsFor([...people], guidance), messages };
}
