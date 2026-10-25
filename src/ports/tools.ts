// Tools the agent can call, each with its definition (what people and the model read about it, the
// input it takes and what it gives back), how much a call can do, and running it; the toolsets they
// come in; and the mode orgs and spaces set for each. A tool's id names where it comes from:
// `thread.rename` for Mage's own, `mcp:<server>/<tool>` for an MCP server's, later `skill:<name>`.

import type * as z from "zod";

import type { NewEvent } from "@/ports/threads.ts";
import type { ToolRisk } from "@/shared/threads.ts";
import type { JsonSchema, ToolLevel, ToolMode, ToolsetSource } from "@/shared/tools.ts";

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
  // Who allowed this call, when it waited for someone; whose credentials it may go with.
  approvedBy: string | null;
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
  // What it takes and gives back as JSON Schemas, for a tool that defines them so rather than
  // with `input` and `output`; `input` then only checks the shape.
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  // What a call gives back when it succeeds, where the tool says.
  output?: z.ZodType;
  annotations?: Record<string, unknown>;
  risk(input: I, ctx: Pick<ToolContext, "model">): ToolRisk;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

// Any tool, whatever its input.
export type AnyToolSpec = ToolSpec<any>;

// Tools from one provider, set out together: Mage's own, or one MCP server's.
export interface Toolset {
  id: string;
  title: string;
  source: ToolsetSource;
  tools: AnyToolSpec[];
}

// The toolsets that come and go with what orgs and spaces add, such as their MCP servers: those
// every space of an org has, and those one space has of its own.
export interface ScopedToolsets {
  inOrg(orgId: string): Toolset[];
  inSpace(space: { id: string; orgId: string }): Toolset[];
}

// The modes an org or a space set, by tool, for the tools it set. A tool the org did not set is
// allowed; one the space did not set has the org's mode. Later a row may also say whose
// credentials a tool's calls must go with.
export interface ToolSettingStore {
  inOrg(orgId: string): Map<string, ToolMode>;
  setInOrg(orgId: string, toolIds: readonly string[], mode: ToolMode): void;
  inSpace(spaceId: string): Map<string, ToolMode>;
  setInSpace(spaceId: string, toolIds: readonly string[], mode: ToolMode): void;
}
