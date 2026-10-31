// Tools the agent can call, each with its definition (what people and the model read about it, the
// input it takes and what it gives back), how much a call can do, and running it; the toolsets they
// come in; the access policies orgs and spaces keep; and the policy each sets for each tool. A
// tool's id names where it comes from: `thread.rename` for Mage's own, `skills.load` for the Skills
// toolset's, `mcp:<server>/<tool>` for an MCP server's.

import type * as z from "zod";

import type { NewEvent } from "@/ports/threads.ts";
import type { AskAnswers } from "@/shared/ask.ts";
import type { ToolRisk } from "@/shared/threads.ts";
import type {
  JsonSchema,
  PolicyColor,
  PolicyUse,
  ToolLevel,
  ToolsetSource,
} from "@/shared/tools.ts";

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
  // Who allowed this call, when it waited for someone; whose credentials it may go with.
  approvedBy: string | null;
  // What was answered, for a tool that waits for answers.
  answers?: AskAnswers;
  write<T>(work: (append: (event: NewEvent, title?: string) => void) => T): T;
}

// A tool as MCP defines one: its name (the tool's id), what it is called and does, and the JSON
// Schemas of what it takes and gives back. People and the model see it the same.
export interface ToolSpec<I = unknown> {
  name: string;
  // What the model calls it, when not its id.
  modelName?: string;
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
  // A tool whose every call waits for someone in the thread to answer it before it runs; who may
  // answer follows its rules as approving does, and an answer counts as its writer's words.
  waitsFor?: "answer";
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
  // Whether a space has any use for it now, such as skills to load; always, when not given.
  usefulIn?(space: { id: string; orgId: string }): boolean;
}

// The toolsets that come and go with what orgs and spaces add, such as their MCP servers: those
// the org offers every space, and those one space has: the org's it did not turn off, and its own.
export interface ScopedToolsets {
  inSpace(space: { id: string; orgId: string }): Toolset[];
  // Settings include servers that are off so their permissions can be reviewed before enabling.
  forOrgSettings(orgId: string): Toolset[];
  forSpaceSettings(space: { id: string; orgId: string }): Toolset[];
}

// What an org or a space set each tool to, for the tools it set: a policy's id, or "off". A tool
// the org did not set is open to everyone; one a space did not set adds no rule of its own.
export interface ToolSettingStore {
  inOrg(orgId: string): Map<string, string>;
  // Sets the tools to the policy or off, or with null takes back what was set.
  setInOrg(orgId: string, toolIds: readonly string[], assignment: string | null): void;
  inSpace(spaceId: string): Map<string, string>;
  setInSpace(spaceId: string, toolIds: readonly string[], assignment: string | null): void;
  // Every tool set to a policy in the org or in any of its spaces.
  policyUses(orgId: string): { spaceId: string | null; toolId: string; policyId: string }[];
  toolsetsInOrg(orgId: string): Map<string, boolean>;
  setToolsetInOrg(orgId: string, toolsetId: string, enabled: boolean): void;
  toolsetsInSpace(spaceId: string): Map<string, boolean>;
  setToolsetInSpace(spaceId: string, toolsetId: string, enabled: boolean): void;
}

// A reusable access rule: who can use its tools without approval, and who approves everyone else.
// The org's are usable in every space; a space's only there. People and groups are kept by key.
export interface ToolPolicyRecord {
  id: string;
  orgId: string;
  spaceId: string | null;
  name: string;
  color: PolicyColor;
  use: PolicyUse;
  users: string[];
  approvers: string[];
  independent: boolean;
  createdAt: Date;
}

export type ToolPolicyFields = Pick<
  ToolPolicyRecord,
  "name" | "color" | "use" | "users" | "approvers" | "independent"
>;

export interface ToolPolicyStore {
  // The org's policies and those of its spaces, oldest first.
  inOrg(orgId: string): ToolPolicyRecord[];
  find(id: string): ToolPolicyRecord | null;
  create(policy: Pick<ToolPolicyRecord, "orgId" | "spaceId"> & ToolPolicyFields): ToolPolicyRecord;
  update(id: string, fields: ToolPolicyFields): void;
  // Deletes the policy, and anything still set to it.
  delete(id: string): void;
}
