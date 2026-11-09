// The agent's tools in each thread: which ones its space offers, who may use each directly and who
// may approve a call, and whether a call runs now, runs on a standing approval or waits; people's
// decisions on calls that wait, and their answers to calls that ask; and the policies orgs and
// spaces set for each tool. Mage's own tools and the toolsets an org adds are in every space of the
// org; a space may add toolsets of its own. An org sets each of its tools to a policy or off, for
// all its spaces; a space adds an extra rule of its own on top, or turns a tool off there, and sets
// its own toolsets' tools as it likes.

import { createHash } from "node:crypto";

import * as z from "zod";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { EventBus } from "@/server/kernel/event-bus.ts";
import type { ModelTool } from "@/server/models/gateway.ts";
import type { Directory } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import type { ThreadAccess } from "@/server/spaces/thread-access.ts";
import { eventSummary, type ThreadLog } from "@/server/threads/log.ts";
import type { Thread, ThreadStore, NewEvent } from "@/server/threads/service.ts";
import { type AskAnswers, askInputSchema, answersProblem } from "@/shared/ask.ts";
import { mcpToolOf } from "@/shared/mcp.ts";
import { START_SUBAGENT } from "@/shared/subagents.ts";
import { LOAD_SKILL } from "@/shared/skills.ts";
import type { ToolRisk, ToolScope } from "@/shared/threads/events.ts";
import {
  toolIdNow,
  TOOL_OFF,
  WIRE_NAME_MAX,
  wireToolName,
  type ToolConnection,
  type ToolDefinition,
  type ToolPolicyChange,
  type ToolsetSetting,
  type JsonSchema,
  type PolicyColor,
  type PolicyUse,
  type ToolLevel,
  type ToolsetSource,
} from "@/shared/tools.ts";
import { type ToolRow, type TranscriptRow, transcriptOf } from "@/shared/transcript.ts";

import type { ThreadRequest } from "./compaction.ts";
import type { ToolsetGuidance } from "./context.ts";
import type { RunStore } from "./runs.ts";
import {
  type Approval,
  canPostIn,
  canUse,
  decide,
  type Decision,
  holds,
  type Influence,
  latestAuthor,
  mayAnswer,
  mayApprove,
  NOBODY,
  OPEN,
  type Person,
  personOf,
  type Rule,
  ruleFor,
  riskOf as riskUnder,
  stillPosts,
  type ToolRule,
  wordsIn,
} from "./tool-authority.ts";

export type { ToolLevel };

// What a call gave back or why it failed, and for a tool that runs with each person's own
// credentials whose it ran with, which the thread records and the model never reads.
export type ToolOutput = ({ ok: true; value: unknown } | { ok: false; error: string }) & {
  ranAs?: string;
};

// An MCP server's tool a run may leave out of the model's requests until the model turns it on:
// its id, what the model knows it by, its server and the start of its tools' names there, and
// what it does and takes.
export interface DeferredTool {
  id: string;
  name: string;
  server: string;
  prefix: string;
  description: string;
  inputSchema: JsonSchema;
}

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
  // Whose own login the call goes with, for a tool that uses one: whoever approved it, whoever gave
  // the standing approval it ran on, or the one person whose words the model read.
  runAs: string | null;
  // What was answered, for a tool that waits for answers.
  answers?: AskAnswers;
  // The MCP tools the run leaves out of the model's requests, those turned on among them, and a
  // way to turn some on for the rest of the thread, for the tool that searches them.
  deferred?: { tools: DeferredTool[]; on: ReadonlySet<string>; turnOn(ids: string[]): void };
  // What the thread's next model call would send, for a tool that asks the thread's model.
  threadRequest?: () => ThreadRequest;
  // Aborted once the run is to stop, for a tool that waits.
  signal?: AbortSignal;
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
  // One always on where it is of use: no switch turns it off and no policy applies to it.
  fixed?: boolean;
  // Whether a space has any use for it now; always, when not given.
  usefulIn?(space: { id: string; orgId: string }): boolean;
  // A tool whose every call waits for someone in the thread to answer it before it runs; who may
  // answer follows its rules as approving does, and an answer counts as its writer's words.
  waitsFor?: "answer";
  // For a tool whose calls run with the own login of the person they run as: each person's
  // connection a call with this input would go with, or null for a call that goes with shared
  // credentials, as when the input names a server whose credentials are shared. Such a call runs
  // directly only for one connected writer; otherwise it waits for an approver, who connects first
  // and whose login it then runs with.
  connection?(
    input: I,
    space: Pick<Space, "id" | "orgId">,
  ): ((userId: string) => ToolConnection) | null;
  risk(input: I, ctx: Pick<ToolContext, "model">): ToolRisk;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

// Any tool, whatever its input.
export type AnyToolSpec = ToolSpec<any>;

// Tools from one provider, set out together: Mage's own, or one MCP server's. One of Mage's own may
// have no tools, only guidance for the agent.
export interface Toolset {
  id: string;
  title: string;
  source: ToolsetSource;
  tools: AnyToolSpec[];
  // What it is for, where settings show it without tools.
  description?: string;
  // What the agent is told while it is on in the thread's space.
  guidance?: string;
  // What the model's names for its tools start with, for an MCP server's: mcp.<slug>.
  prefix?: string;
  // Whether a space has any use for it now, such as skills to load; always, when not given.
  usefulIn?(space: { id: string; orgId: string }): boolean;
  // For one of Mage's own, the options orgs and spaces may turn on, each off until they do.
  options?: { id: string; title: string }[];
  // One of Mage's own whose tools are all fixed, and whose guidance is always given where it is of
  // use.
  fixed?: boolean;
  // For a fixed one, whether the org's settings, or a space's, show it: where it may be offered.
  // Always, when not given.
  listedIn?(scope: { orgId: string; spaceId: string | null }): boolean;
}

// What the model's names for the tools all start with, as a dotted namespace, when they share one.
function namespaceOf(tools: readonly AnyToolSpec[]) {
  const spaces = new Set(
    tools.map((spec) => (spec.modelName ?? spec.name).split(".").slice(0, -1).join(".")),
  );
  const [only] = spaces;
  return spaces.size === 1 && only ? only : undefined;
}

// Whether the tool of the toolset is always on where it is of use.
function fixedIn(toolset: Toolset, spec: AnyToolSpec) {
  return !!(toolset.fixed || spec.fixed);
}

// The toolsets that come and go with what orgs and spaces add, such as their MCP servers: those
// the org offers every space, and those one space has: the org's it did not turn off, and its own.
export interface ScopedToolsets {
  inSpace(space: { id: string; orgId: string }): Toolset[];
  // Settings include servers that are off so their permissions can be reviewed before enabling.
  forOrgSettings(orgId: string): Toolset[];
  forSpaceSettings(space: { id: string; orgId: string }): Toolset[];
  // What a tool the toolsets no longer have is called, as what added it still knows it; null for
  // a tool of none of theirs.
  named(toolId: string): ToolNames | null;
}

// What a tool is called where its calls show, and the toolset or MCP server it comes in.
export interface ToolNames {
  title: string;
  toolset: string | null;
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
  // The options of built-in toolsets set on or off, by toolset and then option.
  optionsInOrg(orgId: string): Map<string, Map<string, boolean>>;
  setOptionInOrg(orgId: string, toolsetId: string, option: string, enabled: boolean): void;
  optionsInSpace(spaceId: string): Map<string, Map<string, boolean>>;
  setOptionInSpace(spaceId: string, toolsetId: string, option: string, enabled: boolean): void;
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

// The tool as MCP defines one.
export function definitionOf(spec: AnyToolSpec): ToolDefinition {
  return {
    name: spec.name,
    ...(spec.title && { title: spec.title }),
    description: spec.description,
    inputSchema:
      spec.inputSchema ?? (z.toJSONSchema(spec.input, { io: "input" }) as Record<string, unknown>),
    ...(spec.outputSchema && { outputSchema: spec.outputSchema }),
    ...(!spec.outputSchema &&
      spec.output && {
        outputSchema: z.toJSONSchema(spec.output, { io: "output" }) as Record<string, unknown>,
      }),
    ...(spec.annotations && { annotations: spec.annotations }),
  };
}

// The schema keywords that label things for people, which the model has no use for.
const LABELS = new Set(["$schema", "title"]);

// Keywords whose value is one schema, and those whose value is a list or a map of them.
const SUBSCHEMA = new Set([
  "items",
  "not",
  "additionalProperties",
  "contains",
  "if",
  "then",
  "else",
]);
const SUBSCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SUBSCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

// The schema without its labels, at every level.
function unlabelled(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !LABELS.has(key))
      .map(([key, value]): [string, unknown] => {
        if (SUBSCHEMA.has(key)) return [key, unlabelled(value)];
        if (SUBSCHEMA_LISTS.has(key) && Array.isArray(value)) {
          return [key, value.map(unlabelled)];
        }
        if (SUBSCHEMA_MAPS.has(key) && typeof value === "object" && value !== null) {
          const entries = Object.entries(value).map(([name, sub]) => [name, unlabelled(sub)]);
          return [key, Object.fromEntries(entries)];
        }
        return [key, value];
      }),
  );
}

// Choices between whole inputs, which providers refuse at the top of a tool's schema, and how many
// of their branches an input must match. The tool still checks its input against them.
const TOP_LEVEL_CHOICES = { oneOf: "exactly one", anyOf: "at least one", allOf: "all" } as const;

// A top-level choice told in words, when each branch only names the parameters it requires.
function choiceInWords(schema: Record<string, unknown>) {
  const lines = Object.entries(TOP_LEVEL_CHOICES).flatMap(([key, count]) => {
    const branches = schema[key];
    if (!Array.isArray(branches)) return [];
    const sets = branches.map((branch: unknown) => {
      const { required, ...rest } = (branch ?? {}) as { required?: unknown };
      return Array.isArray(required) && Object.keys(rest).length === 0 ? required : null;
    });
    if (sets.some((set) => set === null)) return [];
    const options = sets.map((set) => `(${(set as string[]).join(", ")})`).join(" or ");
    return [`Input constraint: Provide parameters for ${count} of: ${options}.`];
  });
  return lines.join("\n");
}

// The tool as the model is told about it: its id, what it does, and what it takes, without the
// labels its schema carries for people; choices between whole inputs move into the description.
export function modelToolOf(spec: AnyToolSpec): ModelTool {
  const schema = unlabelled(definitionOf(spec).inputSchema) as Record<string, unknown>;
  const choice = choiceInWords(schema);
  return {
    id: spec.name,
    description: choice ? `${choice}\n\n${spec.description}` : spec.description,
    inputSchema: Object.fromEntries(
      Object.entries(schema).filter(([key]) => !(key in TOP_LEVEL_CHOICES)),
    ),
  };
}

// The name the model knows each tool by: its own model name or its id, unique among the tools once
// providers' characters are applied, and short enough for them; one too long, or that would clash,
// ends in a short hash of its id.
export function modelToolNames(tools: readonly { id: string; name: string }[]) {
  const used = new Set<string>();
  const names = new Map<string, string>();
  const fits = (name: string) => wireToolName(name).length <= WIRE_NAME_MAX;
  for (const { id, name } of tools) {
    let chosen = name;
    for (let round = 0; !fits(chosen) || used.has(wireToolName(chosen)); round += 1) {
      const hash = createHash("sha256")
        .update(round ? `${id}#${round}` : id)
        .digest("hex")
        .slice(0, 6);
      let prefix = name;
      while (!fits(`${prefix}_${hash}`)) prefix = prefix.slice(0, -1);
      chosen = `${prefix}_${hash}`;
    }
    used.add(wireToolName(chosen));
    names.set(id, chosen);
  }
  return names;
}

// Model names both ways, for one run.
export interface ModelNames {
  toModel: (id: string) => string;
  fromModel: (name: string) => string | undefined;
}

export interface ToolsOptions {
  // Mage's own.
  toolsets: Toolset[];
  // Those orgs and spaces add.
  scoped?: ScopedToolsets;
  settings: ToolSettingStore;
  policies: Pick<ToolPolicyStore, "inOrg">;
  directory: Pick<Directory, "groupIdsOf">;
  access: Pick<ThreadAccess, "of">;
}

export type Tools = ReturnType<typeof createTools>;

// What applies to one tool in a space: whether it is off there, and the one rule it is used under.
export interface ToolRules {
  off: boolean;
  rule: ToolRule;
}

function ruleOf(policy: ToolPolicyRecord): Rule {
  return {
    use: policy.use,
    users: policy.users,
    approvers: policy.approvers,
    independent: policy.independent,
  };
}

export function createTools(options: ToolsOptions) {
  const { toolsets, settings, policies, directory, access } = options;
  // Each of Mage's own toolsets has an id of its own, and its tools' names start with it, so no
  // two of them can offer a tool by the same name. None is under mcp.*, which is MCP servers' own,
  // so no server's tool can clash with its tools either.
  for (const [index, toolset] of toolsets.entries()) {
    if (toolsets.findIndex((other) => other.id === toolset.id) !== index) {
      throw new Error(`Two of Mage's own toolsets are named ${toolset.id}`);
    }
    const stray = toolset.tools.find((spec) => !spec.name.startsWith(`${toolset.id}.`));
    if (toolset.id.split(".")[0] === "mcp" || stray) {
      throw new Error(`${stray?.name ?? toolset.id} is outside its toolset's names`);
    }
  }
  const scoped = options.scoped ?? {
    inSpace: () => [],
    forOrgSettings: () => [],
    forSpaceSettings: () => [],
    named: () => null,
  };

  // The toolsets with the tools policies may be set on: those not fixed.
  const settable = toolsets.flatMap((toolset) => {
    const tools = toolset.tools.filter((spec) => !fixedIn(toolset, spec));
    return tools.length > 0 ? [{ ...toolset, tools }] : [];
  });
  const fixedTools = new Set(
    toolsets.flatMap((toolset) =>
      toolset.tools.filter((spec) => fixedIn(toolset, spec)).map((spec) => spec.name),
    ),
  );

  function settingsInOrg(orgId: string) {
    return [...settable, ...scoped.forOrgSettings(orgId)];
  }

  function settingsInSpace(space: Pick<Space, "id" | "orgId">) {
    return [...settable, ...scoped.forSpaceSettings(space)];
  }

  // The toolsets settings show: Mage's own with their fixed tools, a fixed one only where it may be
  // offered, and those of what the org and the space added.
  function shownInOrg(orgId: string) {
    const scope = { orgId, spaceId: null };
    return [...listed(scope), ...scoped.forOrgSettings(orgId)];
  }

  function shownInSpace(space: Pick<Space, "id" | "orgId">) {
    const scope = { orgId: space.orgId, spaceId: space.id };
    return [...listed(scope), ...scoped.forSpaceSettings(space)];
  }

  function listed(scope: { orgId: string; spaceId: string | null }) {
    return toolsets.filter((toolset) => toolset.listedIn?.(scope) ?? true);
  }

  // Every tool the space may have called, on or off, fixed ones among them.
  function everyIn(space: Pick<Space, "id" | "orgId">) {
    return specsOf([...toolsets, ...scoped.forSpaceSettings(space)]);
  }

  // The toolsets the space has: Mage's own of use there, with their fixed tools and, while they
  // are on, the rest, each tool of use there too; and those of what the org and the space added.
  function inSpace(space: Pick<Space, "id" | "orgId">): Toolset[] {
    const org = settings.toolsetsInOrg(space.orgId);
    const own = settings.toolsetsInSpace(space.id);
    const builtin = toolsets.flatMap((set) => {
      if (!(set.usefulIn?.(space) ?? true)) return [];
      const on = org.get(set.id) !== false && own.get(set.id) !== false;
      const tools = set.tools.filter(
        (spec) => (on || fixedIn(set, spec)) && (spec.usefulIn?.(space) ?? true),
      );
      // One whose tools are all off or of no use is not there; one with only guidance is, while on.
      const there = set.tools.length > 0 ? tools.length > 0 : on || set.fixed;
      return there ? [{ ...set, tools }] : [];
    });
    return [...builtin, ...scoped.inSpace(space)];
  }

  function specsOf(sets: Toolset[]) {
    return sets.flatMap((toolset) => toolset.tools);
  }

  // What applies to each tool in the space. The org's tools take the org's policy, or are open
  // when it set none, with the space's extra rule on top; the space's own take the space's
  // policy, or are open. Off in either is off. A policy that is gone, or not the scope's to use,
  // lets nobody use the tool and nobody approve it. Fixed tools are always open.
  function rulesIn(space: Pick<Space, "id" | "orgId">): (toolId: string) => ToolRules {
    const orgTools = new Set(specsOf(settingsInOrg(space.orgId)).map((spec) => spec.name));
    const org = settings.inOrg(space.orgId);
    const own = settings.inSpace(space.id);
    const byId = new Map(policies.inOrg(space.orgId).map((policy) => [policy.id, policy]));
    const policyRule = (id: string, spaceOk: boolean) => {
      const policy = byId.get(id);
      if (!policy || (policy.spaceId !== null && !(spaceOk && policy.spaceId === space.id))) {
        return NOBODY;
      }
      return ruleOf(policy);
    };
    return (toolId) => {
      if (fixedTools.has(toolId)) return { off: false, rule: ruleFor([OPEN]) };
      const fromOrg = orgTools.has(toolId);
      const inOrg = fromOrg ? org.get(toolId) : undefined;
      const inSpace = own.get(toolId);
      const rules: Rule[] = [];
      if (fromOrg) rules.push(inOrg && inOrg !== TOOL_OFF ? policyRule(inOrg, false) : OPEN);
      if (inSpace && inSpace !== TOOL_OFF) rules.push(policyRule(inSpace, true));
      else if (!fromOrg) rules.push(OPEN);
      return { off: inOrg === TOOL_OFF || inSpace === TOOL_OFF, rule: ruleFor(rules) };
    };
  }

  // The tools the space offers: those not off there.
  function offered(space: Pick<Space, "id" | "orgId">) {
    const rules = rulesIn(space);
    return specsOf(inSpace(space)).filter((spec) => !rules(spec.name).off);
  }

  // How much a call needs: as the tool says, raised where the tool's rules ask more.
  function riskOf(
    space: Pick<Space, "id" | "orgId">,
    spec: AnyToolSpec,
    input: unknown,
    model: string | null,
  ): ToolRisk {
    return riskUnder(spec.risk(input, { model }), rulesIn(space)(spec.name).rule);
  }

  // The person as the rule sees them: whether they can post in the thread as they reach it now,
  // and the groups they are active in now.
  function personIn(userId: string, thread: Thread, space: Space): Person {
    return personOf(
      userId,
      canPostIn(access.of({ userId, orgId: space.orgId }, thread)),
      directory.groupIdsOf(space.orgId, userId),
    );
  }

  // A pending request keeps its history, but decisions follow the tool's current policy.
  function riskForCall(
    row: ToolRow,
    space: Pick<Space, "id" | "orgId">,
    model: string | null = null,
  ): ToolRisk {
    const spec = everyIn(space).find((tool) => tool.name === row.toolId);
    const parsed = spec?.input.safeParse(row.input);
    return spec && parsed?.success ? riskOf(space, spec, parsed.data, model) : row.risk;
  }

  // Whether the call waits for an answer rather than a decision.
  function asks(row: Pick<ToolRow, "toolId">, space: Pick<Space, "id" | "orgId">) {
    const spec = everyIn(space).find((tool) => tool.name === row.toolId);
    return spec?.waitsFor === "answer";
  }

  // Whether the person may act on the call now: approve or deny it, or for a call that asks
  // questions, answer or skip them.
  function canDecide(
    userId: string,
    row: ToolRow,
    rows: readonly TranscriptRow[],
    thread: Thread,
    space: Space,
    model: string | null = null,
  ) {
    return (asks(row, space) ? mayAnswer : mayApprove)(
      personIn(userId, thread, space),
      rulesIn(space)(row.toolId).rule,
      riskForCall(row, space, model),
      latestAuthor(rows),
    );
  }

  // The words the model read, messages and answers, each with whether its writer can post now and
  // whether they may use the tool directly under the rule.
  function influenceOf(
    rows: readonly TranscriptRow[],
    thread: Thread,
    space: Space,
    rule: ToolRule,
  ) {
    const people = new Map<string, Person>();
    const influence: Influence[] = [];
    for (const { seq, userId } of wordsIn(rows)) {
      let person = people.get(userId);
      if (!person) {
        person = personIn(userId, thread, space);
        people.set(userId, person);
      }
      influence.push({ seq, userId, canPost: person.canPost, canUse: canUse(person, rule) });
    }
    return influence;
  }

  // What each tool the space may have called is called now, with its toolset, those called under
  // a former id among them.
  function namesNow(space: Pick<Space, "id" | "orgId">): (toolId: string) => ToolNames | null {
    const names = new Map<string, ToolNames>();
    for (const toolset of [...toolsets, ...scoped.forSpaceSettings(space)]) {
      for (const spec of toolset.tools) {
        if (names.has(spec.name)) continue;
        names.set(spec.name, { title: spec.title ?? spec.name, toolset: toolset.title });
      }
    }
    return (toolId) => names.get(toolIdNow(toolId)) ?? null;
  }

  // What each call is called where it shows: as its tool is called now; else as it was when the
  // call was asked for; else by what the model knows it by, where what added it is still there;
  // else by its id, or for an MCP server's tool, its own name there. Loading a skill names the
  // skill, and starting a subagent the subagent.
  function namesIn(space: Pick<Space, "id" | "orgId"> | null) {
    let now: ((toolId: string) => ToolNames | null) | undefined;
    return (
      row: Pick<ToolRow, "toolId" | "input" | "state" | "title" | "toolset"> & {
        output?: ToolRow["output"];
      },
    ): ToolNames => {
      now ??= space ? namesNow(space) : () => null;
      const names = now(row.toolId) ??
        (row.title ? { title: row.title, toolset: row.toolset ?? null } : null) ??
        scoped.named(row.toolId) ?? {
          title: mcpToolOf(row.toolId)?.name ?? row.toolId,
          toolset: null,
        };
      const skill = (row.input as { name?: unknown } | null)?.name;
      if (row.toolId === LOAD_SKILL && typeof skill === "string") {
        return { ...names, title: row.state === "ran" ? `Loaded ${skill}` : `Load ${skill}` };
      }
      // Starting a subagent names the subagent, and the model it was given.
      if (toolIdNow(row.toolId) === START_SUBAGENT && typeof skill === "string") {
        const model = row.output?.ok && (row.output.value as { model?: unknown } | null)?.model;
        const given = typeof model === "string" ? ` · ${model.slice(model.indexOf("/") + 1)}` : "";
        return { ...names, title: `${names.title} · ${skill}${given}` };
      }
      return names;
    };
  }

  // The toolset with each tool's definition, whether the org or the space has it, and whether it
  // and each tool are fixed.
  function withDefinitions(toolset: Toolset, scope: "org" | "space") {
    const { id, title, source, description, prefix, tools } = toolset;
    return {
      id,
      title,
      source,
      ...(description && { description }),
      ...(prefix && { prefix }),
      fixed: !!toolset.fixed,
      scope,
      tools: tools.map((spec) => ({
        definition: definitionOf(spec),
        fixed: !!(toolset.fixed || spec.fixed),
      })),
    };
  }

  return {
    // The tool in the org's toolsets, or in the space's when one is given.
    find(orgId: string, id: string, space?: Pick<Space, "id" | "orgId">) {
      const sets = space ? settingsInSpace(space) : settingsInOrg(orgId);
      return specsOf(sets).find((spec) => spec.name === id) ?? null;
    },

    ids(space: Pick<Space, "id" | "orgId">) {
      return specsOf(inSpace(space)).map((spec) => spec.name);
    },

    // Every tool's definition in the space, as people see it, each named with its toolset: Mage's
    // own with theirs, an MCP server's with the server.
    definitions(space: Pick<Space, "id" | "orgId">): ToolDefinition[] {
      return inSpace(space).flatMap((toolset) =>
        toolset.tools.map((spec) => ({
          ...definitionOf(spec),
          toolset: toolset.title,
        })),
      );
    },

    offered,
    riskOf,
    namesNow,
    namesIn,

    // The tools the space offers from MCP servers, which a run may leave out of its requests until
    // the model turns them on, each as the model knows it.
    fromServers(space: Pick<Space, "id" | "orgId">, names: ModelNames): DeferredTool[] {
      const rules = rulesIn(space);
      return inSpace(space).flatMap((toolset) =>
        toolset.source !== "mcp"
          ? []
          : toolset.tools
              .filter((spec) => !rules(spec.name).off)
              .map((spec) => ({
                id: spec.name,
                name: names.toModel(spec.name),
                server: toolset.title,
                prefix: toolset.prefix ?? "",
                description: spec.description,
                inputSchema: definitionOf(spec).inputSchema,
              })),
      );
    },

    // What the toolsets on in the space tell the agent.
    guidanceIn(space: Pick<Space, "id" | "orgId">): ToolsetGuidance[] {
      return inSpace(space).flatMap((toolset) => {
        if (!toolset.guidance) return [];
        const prefix = toolset.prefix ?? namespaceOf(toolset.tools);
        return [{ name: toolset.title, ...(prefix && { prefix }), text: toolset.guidance }];
      });
    },

    // The names the model knows the space's tools by, those it does not offer now among them, for
    // calls made before.
    modelNames(space: Pick<Space, "id" | "orgId">): ModelNames {
      const names = modelToolNames(
        everyIn(space).map((spec) => ({
          id: spec.name,
          name: spec.modelName ?? spec.name,
        })),
      );
      const ids = new Map([...names].map(([id, name]) => [name, id]));
      return {
        toModel: (id) => names.get(id) ?? id,
        fromModel: (name) => ids.get(name),
      };
    },
    riskForCall,
    canDecide,
    rulesIn,

    // The person's own connection that a call of the tool with this input would run with, for a
    // call that uses each person's own credentials.
    connectionFor(
      space: Pick<Space, "id" | "orgId">,
      toolId: string,
      userId: string,
      input: unknown,
    ): ToolConnection | null {
      const spec = everyIn(space).find((tool) => tool.name === toolId);
      const parsed = spec?.input.safeParse(input);
      if (!spec?.connection || !parsed?.success) return null;
      return spec.connection(parsed.data, space)?.(userId) ?? null;
    },

    // Each tool's level for the person in the thread: whether they may use it without approval.
    levelsFor(userId: string, thread: Thread, space: Space): Record<string, ToolLevel> {
      const person = personIn(userId, thread, space);
      const rules = rulesIn(space);
      return Object.fromEntries(
        specsOf(inSpace(space)).map((spec) => [
          spec.name,
          canUse(person, rules(spec.name).rule) ? "run" : "approve",
        ]),
      );
    },

    // The toolsets of the org, with each tool's definition; a fixed one is always on.
    toolsetsInOrg(orgId: string) {
      const switches = settings.toolsetsInOrg(orgId);
      const options = settings.optionsInOrg(orgId);
      return shownInOrg(orgId).map((toolset) => ({
        ...withDefinitions(toolset, "org"),
        ...(toolset.source === "builtin" && {
          orgEnabled: !!toolset.fixed || switches.get(toolset.id) !== false,
          enabled: !!toolset.fixed || switches.get(toolset.id) !== false,
        }),
        ...(toolset.options && {
          options: toolset.options.map(({ id, title }) => {
            const on = options.get(toolset.id)?.get(id) === true;
            return { id, title, orgEnabled: on, enabled: on };
          }),
        }),
      }));
    },

    // Whether the built-in toolset's option is on in the space: the org turned it on, and the
    // space did not turn it off.
    optionOn(space: Pick<Space, "id" | "orgId">, toolsetId: string, option: string) {
      return (
        settings.optionsInOrg(space.orgId).get(toolsetId)?.get(option) === true &&
        settings.optionsInSpace(space.id).get(toolsetId)?.get(option) !== false
      );
    },

    // The space's: those the org offers it as the org's, and the rest as its own.
    toolsetsInSpace(space: Pick<Space, "id" | "orgId">) {
      const org = new Set(
        [...toolsets, ...scoped.forOrgSettings(space.orgId)].map((toolset) => toolset.id),
      );
      const orgSwitches = settings.toolsetsInOrg(space.orgId);
      const switches = settings.toolsetsInSpace(space.id);
      const orgOptions = settings.optionsInOrg(space.orgId);
      const options = settings.optionsInSpace(space.id);
      return shownInSpace(space).map((toolset) => ({
        ...withDefinitions(toolset, org.has(toolset.id) ? "org" : "space"),
        ...(toolset.source === "builtin" && {
          orgEnabled: !!toolset.fixed || orgSwitches.get(toolset.id) !== false,
          enabled:
            !!toolset.fixed ||
            (orgSwitches.get(toolset.id) !== false && switches.get(toolset.id) !== false),
        }),
        ...(toolset.options && {
          options: toolset.options.map(({ id, title }) => {
            const orgOn = orgOptions.get(toolset.id)?.get(id) === true;
            const on = orgOn && options.get(toolset.id)?.get(id) !== false;
            return { id, title, orgEnabled: orgOn, enabled: on };
          }),
        }),
      }));
    },

    // The tools as the model is told about them.
    forModel(tools: AnyToolSpec[]): ModelTool[] {
      return tools.map(modelToolOf);
    },

    // Whether a call of the tool, with the risk the tool itself declares for it, runs now, on a
    // standing approval, or waits; for a tool whose calls run with a person's own login, as whom.
    decide(
      rows: readonly TranscriptRow[],
      thread: Thread,
      space: Space,
      toolId: string,
      declared: ToolRisk,
      input: unknown,
    ): Decision {
      const { rule } = rulesIn(space)(toolId);
      const spec = everyIn(space).find((tool) => tool.name === toolId);
      const connection = spec?.connection?.(input, space) ?? null;
      // The vouches given for now themselves, not the calls that later ran on them.
      const standing: Approval[] = rows
        .filter(
          (row): row is ToolRow =>
            row.kind === "tool" &&
            row.toolId === toolId &&
            !row.standingOn &&
            row.decision?.scope === "for_now" &&
            row.decision.allow,
        )
        .map((row) => ({
          atSeq: row.decision!.seq,
          by: row.decision!.by.userId,
          eligible: mayApprove(
            personIn(row.decision!.by.userId, thread, space),
            rule,
            "normal",
            null,
          ),
          callId: row.id,
        }));
      return decide({
        declared,
        rule,
        influence: influenceOf(rows, thread, space, rule),
        standing,
        ...(connection && {
          connected: (userId: string) => connection(userId).connected,
        }),
      });
    },

    asks,

    // Whether the answer given to the call still holds, just before it runs: its writer may still
    // use or approve the tool, as things stood when they answered, and everyone who wrote after
    // it can still post in the thread.
    answerHolds(row: ToolRow, rows: readonly TranscriptRow[], thread: Thread, space: Space) {
      if (!row.answers || !row.decision?.allow) return false;
      const { rule } = rulesIn(space)(row.toolId);
      const { by, seq: atSeq } = row.decision;
      const before = rows.filter((other) => other.seq < atSeq && other.id !== row.id);
      const eligible = mayAnswer(
        personIn(by.userId, thread, space),
        rule,
        riskForCall(row, space),
        latestAuthor(before),
      );
      return holds(
        { atSeq, by: by.userId, eligible },
        influenceOf(rows, thread, space, rule),
        stillPosts,
      );
    },

    // Whether the vouch given for the call still holds, just before it runs: its giver may still
    // approve it under the tool's rule now, independently where that applies, and everyone who
    // wrote after it can still post in the thread.
    approvalHolds(
      row: ToolRow,
      rows: readonly TranscriptRow[],
      thread: Thread,
      space: Space,
      risk: ToolRisk = riskForCall(row, space),
    ) {
      if (!row.decision?.allow) return false;
      if (risk === "review" && row.decision.scope !== "once") return false;
      const { rule } = rulesIn(space)(row.toolId);
      const { by, seq: atSeq } = row.decision;
      const eligible = mayApprove(
        personIn(by.userId, thread, space),
        rule,
        risk,
        latestAuthor(rows),
      );
      return holds(
        { atSeq, by: by.userId, eligible },
        influenceOf(rows, thread, space, rule),
        stillPosts,
      );
    },
  };
}

export interface ToolDecisionsOptions {
  tools: Pick<
    Tools,
    | "find"
    | "canDecide"
    | "asks"
    | "riskForCall"
    | "connectionFor"
    | "toolsetsInOrg"
    | "toolsetsInSpace"
  >;
  access: Pick<ThreadAccess, "require">;
  threads: Pick<ThreadStore, "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "find" | "resume">;
  spaces: Pick<Spaces, "require">;
  settings: ToolSettingStore;
  policies: Pick<ToolPolicyStore, "find">;
  log: ThreadLog;
  bus: EventBus;
}

export type ToolDecisions = ReturnType<typeof createToolDecisions>;

const OWNERS_ONLY = "Only the organization's owners can do this";

// People's decisions on calls that wait, and what orgs and spaces set their tools to.
export function createToolDecisions(options: ToolDecisionsOptions) {
  const { tools, access, threads, spaceStore, runs, spaces, settings, policies, log, bus } =
    options;

  function known(orgId: string, toolId: string, space?: Space) {
    if (!tools.find(orgId, toolId, space)) throw new ServiceError(404, "Tool not found");
  }

  // A policy the scope may set its tools to: the org's own, or for a space also its own.
  function usable(policyId: string | null, orgId: string, spaceId: string | null) {
    if (policyId === null || policyId === TOOL_OFF) return;
    const policy = policies.find(policyId);
    if (
      !policy ||
      policy.orgId !== orgId ||
      (policy.spaceId !== null && policy.spaceId !== spaceId)
    ) {
      throw new ServiceError(404, "Policy not found");
    }
  }

  // The toolsets as settings show them, with what each tool is set to.
  function settingsOf(
    toolsets: ReturnType<Tools["toolsetsInSpace"]>,
    assignmentsOf: (
      toolId: string,
      scope: "org" | "space",
    ) => {
      orgPolicy: string | null;
      policy: string | null;
    },
  ): ToolsetSetting[] {
    return toolsets.map((toolset) => ({
      ...toolset,
      tools: toolset.tools.map(({ definition, fixed }) => ({
        id: definition.name,
        definition,
        ...(fixed
          ? { orgPolicy: null, policy: null, fixed }
          : assignmentsOf(definition.name, toolset.scope)),
      })),
    }));
  }

  return {
    // Approves or denies a call waiting for a decision, and wakes its run. The first decision
    // wins; a call whose run ended is no longer needed.
    decide(
      principal: Principal,
      threadId: string,
      callId: string,
      decision: { allow: boolean; scope: ToolScope },
    ) {
      const { thread } = access.require(principal, threadId, "post");
      const space = spaceStore.find(thread.spaceId);
      if (!space) throw new ServiceError(404, "Thread not found");
      const { events, result: runId } = log.write(thread.id, (append) => {
        const rows = transcriptOf(threads.eventsAfter(thread.id, 0).map(eventSummary)).rows;
        const call = rows.find((row): row is ToolRow => row.kind === "tool" && row.id === callId);
        if (!call) throw new ServiceError(404, "Tool call not found");
        const run = runs.find(call.runId);
        const active = run && (run.status === "running" || run.status === "waiting");
        if (!active || call.state === "stopped") throw new ServiceError(409, "No longer needed");
        if (tools.asks(call, space)) throw new ServiceError(409, "This call waits for an answer");
        if (call.state !== "pending" || !call.waits) {
          throw new ServiceError(409, "Already decided");
        }
        if (!tools.canDecide(principal.userId, call, rows, thread, space, run.model)) {
          const independent =
            tools.riskForCall(call, space, run.model) === "review" &&
            latestAuthor(rows) === principal.userId;
          throw new ServiceError(
            403,
            independent
              ? "Independent approval needs someone other than the author of the latest message"
              : "Only this tool's approvers can decide",
          );
        }
        if (
          decision.allow &&
          decision.scope === "for_now" &&
          tools.riskForCall(call, space, run.model) !== "normal"
        ) {
          throw new ServiceError(400, "This call can only be allowed once");
        }
        // A call allowed runs with its approver's own login, where its tool uses one.
        const connection = tools.connectionFor(space, call.toolId, principal.userId, call.input);
        if (decision.allow && connection && !connection.connected) {
          throw new ServiceError(409, `Connect to ${connection.title} first`);
        }
        const actor = { kind: "user" as const, userId: principal.userId };
        if (decision.allow) {
          append({
            type: "tool.approved",
            actor,
            data: { runId: call.runId, callId, scope: decision.scope },
          });
        } else {
          append({
            type: "tool.denied",
            actor,
            data: { runId: call.runId, callId, reason: "denied" },
          });
        }
        runs.resume(call.runId);
        return call.runId;
      });
      bus.wake(thread.id);
      return { runId, event: events[0]! };
    },

    // Answers the questions a call waits on, or with null skips them, and wakes its run. Anyone
    // who may use or approve the tool may; the first answer wins.
    answer(principal: Principal, threadId: string, callId: string, answers: AskAnswers | null) {
      const { thread } = access.require(principal, threadId, "post");
      const space = spaceStore.find(thread.spaceId);
      if (!space) throw new ServiceError(404, "Thread not found");
      const { events, result: runId } = log.write(thread.id, (append) => {
        const rows = transcriptOf(threads.eventsAfter(thread.id, 0).map(eventSummary)).rows;
        const call = rows.find((row): row is ToolRow => row.kind === "tool" && row.id === callId);
        if (!call) throw new ServiceError(404, "Tool call not found");
        if (!tools.asks(call, space)) throw new ServiceError(409, "This call asks nothing");
        const run = runs.find(call.runId);
        const active = run && (run.status === "running" || run.status === "waiting");
        if (!active || call.state === "stopped") throw new ServiceError(409, "No longer needed");
        if (call.state !== "pending") throw new ServiceError(409, "Already answered");
        if (!tools.canDecide(principal.userId, call, rows, thread, space, run.model)) {
          throw new ServiceError(403, "Only people who can use this tool here can answer");
        }
        const asked = askInputSchema.safeParse(call.input);
        const problem = answers && asked.success && answersProblem(asked.data.questions, answers);
        if (problem) throw new ServiceError(400, problem);
        const actor = { kind: "user" as const, userId: principal.userId };
        if (answers) {
          append({ type: "tool.answered", actor, data: { runId: call.runId, callId, answers } });
        } else {
          append({
            type: "tool.denied",
            actor,
            data: { runId: call.runId, callId, reason: "skipped" },
          });
        }
        runs.resume(call.runId);
        return call.runId;
      });
      bus.wake(thread.id);
      return { runId, event: events[0]! };
    },

    // The toolsets with what the org set each tool to.
    orgTools(principal: Principal): ToolsetSetting[] {
      const org = settings.inOrg(principal.orgId);
      return settingsOf(tools.toolsetsInOrg(principal.orgId), (id) => {
        const policy = org.get(id) ?? null;
        return { orgPolicy: policy, policy };
      });
    },

    setOrgTools(principal: Principal, change: ToolPolicyChange) {
      if (principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
      for (const id of change.toolIds) known(principal.orgId, id);
      usable(change.policy, principal.orgId, null);
      settings.setInOrg(principal.orgId, change.toolIds, change.policy);
    },

    // The toolsets with what the org and the space set each tool to.
    spaceTools(principal: Principal, spaceId: string): ToolsetSetting[] {
      const space = spaces.require(principal, spaceId, "manage");
      const org = settings.inOrg(space.orgId);
      const own = settings.inSpace(space.id);
      return settingsOf(tools.toolsetsInSpace(space), (id, scope) => ({
        orgPolicy: scope === "org" ? (org.get(id) ?? null) : null,
        policy: own.get(id) ?? null,
      }));
    },

    setSpaceTools(principal: Principal, spaceId: string, change: ToolPolicyChange) {
      const space = spaces.require(principal, spaceId, "manage");
      for (const id of change.toolIds) known(space.orgId, id, space);
      usable(change.policy, space.orgId, space.id);
      settings.setInSpace(space.id, change.toolIds, change.policy);
    },

    setOrgToolset(principal: Principal, toolsetId: string, enabled: boolean) {
      if (principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
      const toolset = tools
        .toolsetsInOrg(principal.orgId)
        .find((set) => set.id === toolsetId && set.source === "builtin" && !set.fixed);
      if (!toolset) throw new ServiceError(404, "Toolset not found");
      settings.setToolsetInOrg(principal.orgId, toolsetId, enabled);
    },

    // Turns the built-in toolset's option on or off for the org's spaces.
    setOrgToolsetOption(principal: Principal, toolsetId: string, option: string, enabled: boolean) {
      if (principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
      const toolset = tools.toolsetsInOrg(principal.orgId).find((set) => set.id === toolsetId);
      if (!toolset?.options?.some((one) => one.id === option)) {
        throw new ServiceError(404, "Option not found");
      }
      settings.setOptionInOrg(principal.orgId, toolsetId, option, enabled);
    },

    // Turns the option off in the space, or back on while the org has it on.
    setSpaceToolsetOption(
      principal: Principal,
      spaceId: string,
      toolsetId: string,
      option: string,
      enabled: boolean,
    ) {
      const space = spaces.require(principal, spaceId, "manage");
      const toolset = tools.toolsetsInSpace(space).find((set) => set.id === toolsetId);
      const found = toolset?.options?.find((one) => one.id === option);
      if (!found) throw new ServiceError(404, "Option not found");
      if (enabled && !found.orgEnabled) {
        throw new ServiceError(409, "The organization turned this option off");
      }
      settings.setOptionInSpace(spaceId, toolsetId, option, enabled);
    },

    setSpaceToolset(principal: Principal, spaceId: string, toolsetId: string, enabled: boolean) {
      const space = spaces.require(principal, spaceId, "manage");
      const toolset = tools
        .toolsetsInSpace(space)
        .find((set) => set.id === toolsetId && set.source === "builtin" && !set.fixed);
      if (!toolset) throw new ServiceError(404, "Toolset not found");
      if (enabled && !toolset.orgEnabled)
        throw new ServiceError(409, "The organization turned this toolset off");
      settings.setToolsetInSpace(spaceId, toolsetId, enabled);
    },
  };
}
