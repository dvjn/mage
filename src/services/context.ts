// What the agent is given to reply from: a short system prompt naming Mage and the people in the
// thread, and the thread's messages in the order the agent saw them, each person's prefixed with
// their name. Quiet asides are included; replies still being written are not.

import type { ModelMessage } from "@/ports/model-gateway.ts";
import { QUIET_PREFIX } from "@/shared/threads.ts";
import type { HumanRow, TranscriptRow } from "@/shared/transcript.ts";

export interface Context {
  instructions: string;
  messages: ModelMessage[];
}

export function humanMessage(row: Pick<HumanRow, "author" | "text">): ModelMessage {
  return { role: "user", text: `[${row.author.name}] ${row.text}` };
}

export function instructionsFor(people: string[]) {
  return [
    "You are the agent in Mage, a workspace where people talk with you and with each other in shared threads.",
    `The people in this thread: ${people.join(", ")}.`,
    "Each of their messages starts with the writer's name in brackets, like [Ada Lovelace]. Your replies do not start with a name.",
    `A message starting with ${QUIET_PREFIX} is an aside between people: take it in as context, but do not answer it.`,
    "Reply in Markdown.",
  ].join("\n");
}

export function contextOf(rows: readonly TranscriptRow[]): Context {
  const people = new Set<string>();
  const messages: ModelMessage[] = [];
  for (const row of rows) {
    if (row.kind === "human") {
      people.add(row.author.name);
      messages.push(humanMessage(row));
    } else if (row.kind === "agent" && row.status !== "streaming" && row.text) {
      messages.push({ role: "assistant", text: row.text });
    }
  }
  return { instructions: instructionsFor([...people]), messages };
}
