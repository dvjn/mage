// Whose words a thread's agent read: the people who wrote in it or answered its questions, and
// those whose words other agents' messages carried, each with the agents their words came through.
// A call carries them to whatever it sets going, and a waiting call shows them.

import { personLabel } from "@/shared/people.ts";
import type { Influencer } from "@/shared/threads/events.ts";
import type { TranscriptRow } from "@/shared/transcript.ts";

// What stands for the agent of a thread where its words carried on into a subagent's thread; it
// shows as the name that agent goes by.
export const AGENT_NAME = "Agent";

// Everyone whose words the thread's agent read, each with the agents their words came through:
// those who wrote in the thread or answered its questions, and those who steered the messages
// other agents sent it. Each person and way once.
export function influenceIn(rows: readonly TranscriptRow[]): Influencer[] {
  const steering = new Map<string, Influencer>();
  const add = (entry: Influencer) => {
    const key = JSON.stringify([entry.userId, entry.via]);
    if (!steering.has(key)) steering.set(key, entry);
  };
  for (const row of rows) {
    if (row.kind === "human")
      add({ userId: row.author.userId, name: personLabel(row.author), via: [] });
    else if (row.kind === "notice") row.influence.forEach(add);
    else if (row.kind === "tool" && row.answers && row.decision) {
      add({ userId: row.decision.by.userId, name: personLabel(row.decision.by), via: [] });
    }
  }
  return [...steering.values()];
}

// Everyone whose words the thread's agent read, from the words it read in order: each person and
// way once, as `influenceIn` gives them from its fold.
export function influenceOf(words: readonly Influencer[]): Influencer[] {
  const steering = new Map<string, Influencer>();
  for (const { userId, name, via } of words) {
    const key = JSON.stringify([userId, via]);
    if (!steering.has(key)) steering.set(key, { userId, name, via });
  }
  return [...steering.values()];
}

// Everyone whose words steered the thread's agent, named `self`, each person once by the shortest
// way their words came: the agents it passed through, ending in `self`. The agent that started
// subagents shows as `agentName`. Null when no one did.
export function influenceParts(
  rows: readonly TranscriptRow[],
  self: string,
  agentName = AGENT_NAME,
): { name: string; via: string[] }[] | null {
  const shortest = new Map<string, Influencer>();
  for (const entry of influenceIn(rows)) {
    const known = shortest.get(entry.userId);
    if (!known || entry.via.length < known.via.length) shortest.set(entry.userId, entry);
  }
  const parts = [...shortest.values()].map((entry) => ({
    name: entry.name,
    via:
      entry.via.length > 0
        ? [...entry.via.map((via) => (via === AGENT_NAME ? agentName : via)), self]
        : [],
  }));
  return parts.length > 0 ? parts : null;
}
