// Tools the agent can call, each with its definition (what people and the model read about it, the
// input it takes and what it gives back), how much a call can do, and running it; the toolsets they
// come in; and the mode orgs and spaces set for each. A tool's id names where it comes from:
// `thread.rename` for Mage's own, later `mcp:<server>/<tool>` and `skill:<name>`.

import type * as z from "zod";

import type { NewEvent } from "@/ports/threads.ts";
import type { ToolRisk } from "@/shared/threads.ts";
import type { ToolLevel, ToolMode, ToolsetSource } from "@/shared/tools.ts";

export type { ToolLevel, ToolMode };

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

// Any tool, whatever its input.
export type AnyToolSpec = ToolSpec<any>;

// Tools from one provider, set out together: Mage's own, or later one MCP server's.
export interface Toolset {
  id: string;
  title: string;
  source: ToolsetSource;
  tools: AnyToolSpec[];
}

// The modes an org or a space set, by tool, for the tools it set. A tool the org did not set is
// allowed; one the space did not set has the org's mode.
export interface ToolSettingStore {
  inOrg(orgId: string): Map<string, ToolMode>;
  setInOrg(orgId: string, toolIds: readonly string[], mode: ToolMode): void;
  inSpace(spaceId: string): Map<string, ToolMode>;
  setInSpace(spaceId: string, toolIds: readonly string[], mode: ToolMode): void;
}
