// The artifacts a thread's tool calls made, read from their outputs: which one a call published or
// updated, and which of a turn's artifacts to show as cards after its reply.

import { ARTIFACT_TOOLS } from "@/shared/artifacts.ts";
import type { AgentRow, ToolRow } from "@/shared/threads/rows.ts";
import { artifactIdsIn } from "@/web/replies/reply-layout";

export interface CalledArtifact {
  id: string;
  version: number;
  title: string;
}

// The artifact a call that published or updated one made, from its output.
export function artifactOf(row: ToolRow): CalledArtifact | null {
  if (row.state !== "ran" || row.output?.ok !== true) return null;
  if (row.toolId !== ARTIFACT_TOOLS.publish && row.toolId !== ARTIFACT_TOOLS.update) return null;
  const value = row.output.value as { id?: unknown; version?: unknown; title?: unknown } | null;
  if (typeof value?.id !== "string" || typeof value.version !== "number") return null;
  return {
    id: value.id,
    version: value.version,
    title: typeof value.title === "string" ? value.title : "",
  };
}

// One card per artifact the rows published or updated, at its latest version and in the order each
// was first made; none for one a reply already shows with Artifact(id).
export function cardsAfterReply(rows: readonly (ToolRow | AgentRow)[]): CalledArtifact[] {
  const found = new Map<string, CalledArtifact>();
  const shown = new Set<string>();
  for (const row of rows) {
    if (row.kind === "agent") {
      for (const id of artifactIdsIn(row.text)) shown.add(id);
      continue;
    }
    const artifact = artifactOf(row);
    if (artifact) found.set(artifact.id, artifact);
  }
  return [...found.values()].filter((artifact) => !shown.has(artifact.id));
}
