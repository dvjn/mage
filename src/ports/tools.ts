// Tools the agent can call, each with its definition (what people and the model read about it, the
// input it takes and what it gives back), how much a call can do, and running it; and the switches and levels orgs and spaces set for them. A tool's id
// names where it comes from: `thread.rename` for Mage's own, later `mcp:<server>/<tool>` and
// `skill:<name>`.

import type * as z from "zod";

import type { NewEvent } from "@/ports/threads.ts";
import type { ToolRisk } from "@/shared/threads.ts";
import type { ToolLevel } from "@/shared/tools.ts";

export type { ToolLevel };

export type ToolOutput = { ok: true; value: unknown } | { ok: false; error: string };

// Where a call runs: the thread, its space and org, the run and call, and the model ref that
// replies now. `write` appends to the thread while the run still holds it.
export interface ToolContext {
  threadId: string;
  spaceId: string;
  orgId: string;
  runId: string;
  callId: string;
  actor: { kind: "agent" };
  model: string | null;
  write<T>(work: (append: (event: NewEvent, title?: string) => void) => T): T;
}

// A tool as MCP defines one: its name (the tool's id), what it is called and does, and the JSON
// Schemas of what it takes and gives back. People and the model see it the same.
export interface ToolSpec<I = unknown> {
  name: string;
  source: "system" | "mcp" | "skill";
  title?: string;
  // What the model reads; the same for everyone.
  description: string;
  input: z.ZodType<I>;
  // What a call gives back when it succeeds, where the tool says.
  output?: z.ZodType;
  annotations?: Record<string, unknown>;
  risk(input: I, ctx: Pick<ToolContext, "model">): ToolRisk;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

// A space's choices for one tool: off there, and the level its messagers and guests get instead of
// the usual one; null keeps the usual.
export interface SpaceToolSetting {
  toolId: string;
  enabled: boolean;
  messager: ToolLevel | null;
  guest: ToolLevel | null;
}

export interface ToolSettingStore {
  // The tools the org turned off.
  offInOrg(orgId: string): Set<string>;
  setInOrg(orgId: string, toolId: string, enabled: boolean): void;
  // The space's choices, by tool, for the tools it set anything for.
  inSpace(spaceId: string): Map<string, SpaceToolSetting>;
  setInSpace(
    spaceId: string,
    toolId: string,
    changes: Partial<Omit<SpaceToolSetting, "toolId">>,
  ): void;
}
