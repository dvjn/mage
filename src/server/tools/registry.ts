// The agent's tools in each thread: which ones its space offers, who may use each directly and who
// may approve a call, and whether a call runs now, runs on a standing approval or waits; people's
// decisions on calls that wait, and their answers to calls that ask; and the policies orgs and
// spaces set for each tool. Mage's own tools and the toolsets an org adds are in every space of the
// org; a space may add toolsets of its own. An org sets each of its tools to a policy or off, for
// all its spaces; a space adds an extra rule of its own on top, or turns a tool off there, and sets
// its own toolsets' tools as it likes.

import type { OrgSettings } from "@/server/orgs/service.ts";
import { filterAsync } from "@/server/kernel/async.ts";
import { createHash } from "node:crypto";

import * as z from "zod";

import { ServiceError } from "@/server/kernel/errors.ts";
import type { ModelTool } from "@/server/models/gateway.ts";
import type { Directory } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Space, Spaces } from "@/server/spaces/service.ts";
import type { Access, Reader, ThreadAccess } from "@/server/access/access.ts";
import type { Thread, NewEvent } from "@/server/threads/types.ts";
import type { AskAnswers } from "@/shared/ask.ts";
import { mcpToolOf } from "@/shared/mcp.ts";
import type { Influencer, ToolRisk, ToolScope } from "@/shared/threads/events.ts";
import {
  textOf,
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
  type ToolText,
} from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/transcript.ts";
import type { Work } from "@/shared/jobs.ts";
import type { SubagentSummary } from "@/shared/subagents.ts";
import type { CallEffect, ShownRow } from "@/shared/threads/rows.ts";

import type { ThreadRequest } from "@/server/execution/compaction.ts";
import type { LiveReporter } from "@/server/calls/live.ts";
import type { ThreadToolStore } from "./thread-tool-store.ts";
import { choiceInWords, TOP_LEVEL_CHOICES } from "./signatures.ts";
import type { ToolsetGuidance } from "@/server/execution/context.ts";
import {
  type Approval,
  ASKING,
  canPostIn,
  canUse,
  decide,
  type Decision,
  holds,
  type Influence,
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
} from "./authority.ts";
import type { Word } from "@/server/queue/queue.ts";

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
  outputSchema?: JsonSchema;
}

// Where a call runs: the thread, its space and org, the run and call, and the model ref that
// replies now. `write` appends to the thread while the run still holds it.
export interface ToolContext {
  threadId: string;
  spaceId: string;
  orgId: string;
  runId: string;
  callId: string;
  // Set for a call started in the background: it runs under no run, and its own id stands in the
  // run's place.
  background?: true;
  actor: { kind: "agent" };
  model: string | null;
  // Whose own login the call goes with, for a tool that uses one: whoever approved it, whoever gave
  // the standing approval it ran on, or the one person whose words the model read.
  runAs: string | null;
  // Who approved this very call on its approval card, when someone did.
  approvedBy?: string;
  // Everyone whose words the model had read when it asked for the call, with the agents their
  // words came through.
  influence: Influencer[];
  // What was answered, for a tool that waits for answers.
  answers?: AskAnswers;
  // The MCP tools the run leaves out of the model's requests, those turned on among them, and a
  // way to turn some on for the rest of the thread, for the tool that searches them.
  deferred?: {
    tools: DeferredTool[];
    on: ReadonlySet<string>;
    turnOn(ids: string[]): Promise<void>;
  };
  // What the thread's next model call would send, for a tool that asks the thread's model.
  threadRequest?: () => Promise<ThreadRequest>;
  // The name the model calls a tool by, from its id, for text the tool gives it.
  named: (toolId: string) => string;
  // The names the run's model was shown tools by, both ways, for a tool that calls others by name.
  names?: ModelNames;
  // Aborted once the run is to stop, for a tool that waits.
  signal?: AbortSignal;
  // Where a tool that takes long says what it prints and how far it has come, for the people
  // watching the call; the model is not given it.
  live?: LiveReporter;
  write<T>(
    work: (append: (event: NewEvent, title?: string) => Promise<{ seq: number }>) => Promise<T>,
  ): Promise<T>;
}

// A tool as MCP defines one: its name (the tool's id), what it is called and does, and the JSON
// Schemas of what it takes and gives back. People and the model see it the same.
export interface ToolSpec<I = unknown> {
  name: string;
  // What the model calls it, when not its id.
  modelName?: string;
  title?: string;
  // What the model reads; the same for everyone, but for the names of tools it gives.
  description: ToolText;
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
  // For a tool whose every call waits for approval while the org sets no policy on it; a policy
  // set there replaces this.
  byDefault?: "ask";
  // Whether a space has any use for it now; always, when not given. Tools may share one.
  usefulIn?: UseTest;
  // False for a tool whose calls never move to the background, as those that start, check and stop
  // jobs; a tool that waits for an answer never moves either.
  movable?: false;
  // A tool whose every call waits for someone in the thread to answer it before it runs; who may
  // answer follows its rules as approving does, and an answer counts as its writer's words.
  waitsFor?: "answer";
  // The tool that searches the tools a run leaves out of its requests, which it is given.
  deferral?: "search";
  // A tool whose calls make calls of their own, as a script does; one never runs under another
  // call of it, in its run or in the background.
  makesCalls?: true;
  // For a tool whose calls run with the own login of the person they run as: each person's
  // connection a call with this input would go with, or null for a call that goes with shared
  // credentials, as when the input names a server whose credentials are shared. Such a call runs
  // directly only for one connected writer; otherwise it waits for an approver, who connects first
  // and whose login it then runs with.
  connection?(
    input: I,
    space: Pick<Space, "id" | "orgId">,
  ): Promise<((userId: string) => Promise<ToolConnection>) | null>;
  risk(input: I, ctx: Pick<ToolContext, "model" | "orgId">): ToolRisk | Promise<ToolRisk>;
  // A call's input in a few words for the one line it has, where its plain values would not say
  // it; null when the tool cannot say now.
  summary?: (input: I, space: Pick<Space, "id" | "orgId">) => Promise<string | null>;
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
  guidance?: ToolText;
  // What an MCP server says about its own tools, in its words: what it sent, and whether it was
  // cut to fit Mage's cap.
  told?: { text: string; cut: boolean };
  // What the model's names for its tools start with, for an MCP server's: mcp.<slug>.
  prefix?: string;
  // Whether a space has any use for it now, such as skills to load; always, when not given. Its
  // tools may share it.
  usefulIn?: UseTest;
  // What its test of use and what it tells the agent read of a space, read once with the space's
  // tools and handed to both.
  load?: (space: { id: string; orgId: string }, org?: OrgRead) => Promise<unknown>;
  // For one of Mage's own, the options orgs and spaces may turn on, each off until they do.
  options?: { id: string; title: string }[];
  // One of Mage's own whose tools are all fixed, and whose guidance is always given where it is of
  // use.
  fixed?: boolean;
  // For a fixed one, whether the org's settings, or a space's, show it: where it may be offered.
  // Always, when not given.
  listedIn?(scope: { orgId: string; spaceId: string | null }): boolean | Promise<boolean>;
  // What its calls among the rows show the reader beyond their names: asked once for a page.
  present?(reader: Reader, rows: readonly ToolRow[]): Promise<Presenter>;
}

// What a call shows the reader beyond what its row holds: what it is called where that says more,
// the card of the work it stands for, the subagent it started with what that waits on, and where
// it had its effect. `live` says these may change with no new event.
export interface CallPresentation {
  names?: Partial<CallNames>;
  work?: Work | null;
  effects?: CallEffect[];
  subagent?: SubagentSummary;
  subagentCall?: ShownRow;
  live?: boolean;
}

// What one page's calls show, by row.
export type Presenter = (row: ToolRow) => CallPresentation | undefined;

// What decides a call's state of the space's tools: every tool it may have called, and the rules on
// each.
export type CallTools = Pick<SpaceTools, "every" | "rules">;

// Calls' states read for one reader across a request.
export type CallStates = ReturnType<ReturnType<typeof createTools>["callStates"]>;

// What a space has of tools at one moment: its toolsets, and what applies to each tool.
export interface SpaceTools {
  sets: Toolset[];
  rules: (toolId: string) => ToolRules;
  // What orgs and spaces add there, and every tool the space may have called, on or off.
  added: AddedToolsets;
  every: AnyToolSpec[];
  // What each toolset that loads something read, by its id.
  loaded: ReadonlyMap<string, unknown>;
  // The org's settings, read once for all the step reads of them.
  org?: OrgRead;
}

// What orgs and spaces add to one space's tools, read together: the toolsets it uses, and those
// its settings and its org's show, off ones among them so their permissions can be reviewed
// before they are turned on.
export interface AddedToolsets {
  inSpace: Toolset[];
  forSpaceSettings: Toolset[];
  forOrgSettings: Toolset[];
}

// Whether a space has use for a toolset or a tool, given what was read of the space's tools: what
// orgs and spaces add there, what applies to each tool, and what the toolset loaded, if it loads.
export type UseTest = (
  space: { id: string; orgId: string },
  read: { added: AddedToolsets; rules: (toolId: string) => ToolRules; loaded: unknown },
) => boolean | Promise<boolean>;

// What the model's names for the tools all start with, as a dotted namespace, when they share one.
function namespaceOf(tools: readonly AnyToolSpec[]) {
  const spaces = new Set(
    tools.map((spec) => (spec.modelName ?? spec.name).split(".").slice(0, -1).join(".")),
  );
  const [only] = spaces;
  return spaces.size === 1 && only ? only : undefined;
}

// Whether the space has the tool but turned it, or its toolset, off.
export function offIn(now: Pick<SpaceTools, "every" | "sets" | "rules">, toolId: string) {
  if (!now.every.some((spec) => spec.name === toolId)) return false;
  return (
    now.rules(toolId).off || !now.sets.some((set) => set.tools.some((spec) => spec.name === toolId))
  );
}

// Whether the tool of the toolset is always on where it is of use.
function fixedIn(toolset: Toolset, spec: AnyToolSpec) {
  return !!(toolset.fixed || spec.fixed);
}

// The toolsets that come and go with what orgs and spaces add, such as their MCP servers: those
// the org offers every space, and those one space has: the org's it did not turn off, and its own.
export interface ScopedToolsets {
  readIn(space: { id: string; orgId: string }, org?: OrgRead): Promise<AddedToolsets>;
  // Settings include servers that are off so their permissions can be reviewed before enabling.
  forOrgSettings(orgId: string): Promise<Toolset[]>;
  forSpaceSettings(space: { id: string; orgId: string }): Promise<Toolset[]>;
  // What a tool the toolsets no longer have is called, as what added it still knows it; null for
  // a tool of none of theirs.
  named(toolId: string): Promise<ToolNames | null>;
}

// What a tool is called where its calls show, and the toolset or MCP server it comes in.
export interface ToolNames {
  title: string;
  toolset: string | null;
}

// What a call is called: its tool's names, and for a call that loads a skill, the skill; for one
// that starts a subagent, the name it was given and the ref of the model it runs with; and its
// input in a few words, for a call whose tool says it.
export interface CallNames extends ToolNames {
  skill?: string;
  subagentName?: string;
  model?: string;
  summary?: string;
}

// What an org or a space set each tool to, for the tools it set: a policy's id, or "off". A tool
// the org did not set is open to everyone; one a space did not set adds no rule of its own.
export interface ToolSettingStore {
  inOrg(orgId: string): Promise<Map<string, string>>;
  // Sets the tools to the policy or off, or with null takes back what was set.
  setInOrg(orgId: string, toolIds: readonly string[], assignment: string | null): Promise<void>;
  inSpace(spaceId: string): Promise<Map<string, string>>;
  setInSpace(spaceId: string, toolIds: readonly string[], assignment: string | null): Promise<void>;
  // Every tool set to a policy in the org or in any of its spaces.
  policyUses(
    orgId: string,
  ): Promise<{ spaceId: string | null; toolId: string; policyId: string }[]>;
  toolsetsInOrg(orgId: string): Promise<Map<string, boolean>>;
  setToolsetInOrg(orgId: string, toolsetId: string, enabled: boolean): Promise<void>;
  toolsetsInSpace(spaceId: string): Promise<Map<string, boolean>>;
  setToolsetInSpace(spaceId: string, toolsetId: string, enabled: boolean): Promise<void>;
  // The options of built-in toolsets set on or off, by toolset and then option.
  optionsInOrg(orgId: string): Promise<Map<string, Map<string, boolean>>>;
  setOptionInOrg(orgId: string, toolsetId: string, option: string, enabled: boolean): Promise<void>;
  optionsInSpace(spaceId: string): Promise<Map<string, Map<string, boolean>>>;
  setOptionInSpace(
    spaceId: string,
    toolsetId: string,
    option: string,
    enabled: boolean,
  ): Promise<void>;
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
  inOrg(orgId: string): Promise<ToolPolicyRecord[]>;
  find(id: string): Promise<ToolPolicyRecord | null>;
  create(
    policy: Pick<ToolPolicyRecord, "orgId" | "spaceId"> & ToolPolicyFields,
  ): Promise<ToolPolicyRecord>;
  update(id: string, fields: ToolPolicyFields): Promise<void>;
  // Deletes the policy, and anything still set to it.
  delete(id: string): Promise<void>;
}

// The tool as MCP defines one, naming other tools by their ids.
export function definitionOf(spec: AnyToolSpec): ToolDefinition {
  return {
    name: spec.name,
    ...(spec.title && { title: spec.title }),
    description: textOf(spec.description, (id) => id),
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

// The tool as the model is told about it: its id, what it does, and what it takes, without the
// labels its schema carries for people; choices between whole inputs move into the description.
// Other tools it names are named by `named`.
export function modelToolOf(
  spec: AnyToolSpec,
  named: (toolId: string) => string = wireToolName,
): ModelTool {
  const schema = unlabelled(definitionOf(spec).inputSchema) as Record<string, unknown>;
  const choice = choiceInWords(schema);
  const description = textOf(spec.description, named);
  return {
    id: spec.name,
    description: choice ? `${choice}\n\n${description}` : description,
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
  // Whether the space has a tool by the id, offered now or not.
  known: (id: string) => boolean;
}

// People as tools' rules see them in one thread, each read once for calls judged together.
export type People = Map<string, Promise<Person>>;

// The org's settings, read when first asked and once for whatever reads them together.
export type OrgRead = () => Promise<OrgSettings>;

export interface ToolsOptions {
  // The org's own settings, as what the space's tools read of them is read once with them.
  orgSettings?: (orgId: string) => Promise<OrgSettings>;
  settings: ToolSettingStore;
  policies: Pick<ToolPolicyStore, "inOrg">;
  directory: Pick<Directory, "groupIdsOf">;
  access: Pick<ThreadAccess, "of">;
  // The tools each thread turned on by searching for them.
  threadTools: ThreadToolStore;
  // Told of an id that text for the model names but no tool has.
  unknownName?: (toolId: string) => void;
}

export type Tools = ReturnType<typeof createTools>;

// Where a call stands for a person: what it waits on people for, if anything, whether this person
// may give it, and the risk it is judged at now.
export interface CallState {
  waitsFor: "decision" | "answer" | null;
  canAct: boolean;
  risk: ToolRisk;
}

// A call as authority reads it: what it asks, how it waits, and the decision or answer given on it,
// if any, by whom and where in the thread.
export interface CallView {
  id: string;
  seq: number;
  toolId: string;
  input: unknown;
  risk: ToolRisk;
  state: ToolRow["state"];
  waits: boolean;
  answers?: AskAnswers;
  decision: { allow: boolean; scope: ToolScope; by: { userId: string }; seq: number } | null;
}

// Who wrote the latest of the words, which are in the order the model read them.
export function lastWriter(words: readonly Pick<Word, "userId">[]) {
  return words.at(-1)?.userId ?? null;
}

// A vouch for now given on one of the branch's calls of a tool: the call, who gave it and where.
export interface Vouch {
  callId: string;
  toolId: string;
  by: string;
  seq: number;
}

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
  const { settings, policies, directory, access } = options;
  // Mage's own toolsets, in the order they registered, which is the order of the model's tools.
  const toolsets: Toolset[] = [];
  // Those orgs and spaces add.
  let scoped: ScopedToolsets = {
    readIn: async () => ({ inSpace: [], forSpaceSettings: [], forOrgSettings: [] }),
    forOrgSettings: async () => [],
    forSpaceSettings: async () => [],
    named: async () => null,
  };
  const narrowers: ((thread: Thread, offered: AnyToolSpec[]) => Promise<AnyToolSpec[]>)[] = [];
  const presenters: NonNullable<Toolset["present"]>[] = [];

  // The toolsets with the tools policies may be set on: those not fixed.
  function settable() {
    return toolsets.flatMap((toolset) => {
      const tools = toolset.tools.filter((spec) => !fixedIn(toolset, spec));
      return tools.length > 0 ? [{ ...toolset, tools }] : [];
    });
  }

  function isFixed(toolId: string) {
    return toolsets.some((toolset) =>
      toolset.tools.some((spec) => spec.name === toolId && fixedIn(toolset, spec)),
    );
  }

  async function settingsInOrg(orgId: string) {
    return [...settable(), ...(await scoped.forOrgSettings(orgId))];
  }

  async function settingsInSpace(space: Pick<Space, "id" | "orgId">) {
    return [...settable(), ...(await scoped.forSpaceSettings(space))];
  }

  // The toolsets settings show: Mage's own with their fixed tools, a fixed one only where it may be
  // offered, and those of what the org and the space added.
  async function shownInOrg(orgId: string) {
    const scope = { orgId, spaceId: null };
    return [...(await listed(scope)), ...(await scoped.forOrgSettings(orgId))];
  }

  async function shownInSpace(space: Pick<Space, "id" | "orgId">) {
    const scope = { orgId: space.orgId, spaceId: space.id };
    return [...(await listed(scope)), ...(await scoped.forSpaceSettings(space))];
  }

  async function listed(scope: { orgId: string; spaceId: string | null }) {
    return filterAsync(toolsets, async (toolset) => (await toolset.listedIn?.(scope)) ?? true);
  }

  // Every tool the space may have called, on or off, fixed ones among them.
  async function everyIn(space: Pick<Space, "id" | "orgId">, now?: Pick<SpaceTools, "every">) {
    return now?.every ?? specsOf([...toolsets, ...(await scoped.forSpaceSettings(space))]);
  }

  // The toolsets the space has: Mage's own of use there, with their fixed tools and, while they
  // are on, the rest, each tool of use there too; and those of what the org and the space added.
  async function usedIn(
    space: Pick<Space, "id" | "orgId">,
    added: AddedToolsets,
    rules: (toolId: string) => ToolRules,
    loaded: ReadonlyMap<string, unknown>,
  ): Promise<Toolset[]> {
    const org = await settings.toolsetsInOrg(space.orgId);
    const own = await settings.toolsetsInSpace(space.id);
    // Toolsets and tools that share one test of whether they are of use, as the MCP toolset and
    // its tools do, are tested once.
    const tested = new Map<UseTest, Promise<boolean>>();
    const useful = async (set: Toolset, test: UseTest | undefined) => {
      if (!test) return true;
      const answer =
        tested.get(test) ??
        Promise.resolve(test(space, { added, rules, loaded: loaded.get(set.id) }));
      tested.set(test, answer);
      return answer;
    };
    const builtin = (
      await Promise.all(
        toolsets.map(async (set) => {
          if (!(await useful(set, set.usefulIn))) return [];
          const on = org.get(set.id) !== false && own.get(set.id) !== false;
          const tools = await filterAsync(
            set.tools,
            async (spec) => (on || fixedIn(set, spec)) && (await useful(set, spec.usefulIn)),
          );
          // One whose tools are all off or of no use is not there; one with only guidance is, while on.
          const there = set.tools.length > 0 ? tools.length > 0 : on || set.fixed;
          return there ? [{ ...set, tools }] : [];
        }),
      )
    ).flat();
    return [...builtin, ...added.inSpace];
  }

  async function inSpace(space: Pick<Space, "id" | "orgId">): Promise<Toolset[]> {
    return (await toolsIn(space)).sets;
  }

  function definitionsOf(sets: Toolset[]): ToolDefinition[] {
    return sets.flatMap((toolset) =>
      toolset.tools.map((spec) => ({ ...definitionOf(spec), toolset: toolset.title })),
    );
  }

  function specsOf(sets: Toolset[]) {
    return sets.flatMap((toolset) => toolset.tools);
  }

  // What applies to each tool in the space. The org's tools take the org's policy, or are open
  // when it set none (asking, for a tool that asks by default), with the space's extra rule on
  // top; the space's own take the space's policy, or are open. Off in either is off. A policy that
  // is gone, or not the scope's to use, lets nobody use the tool and nobody approve it. Fixed
  // tools are always open.
  async function rulesIn(
    space: Pick<Space, "id" | "orgId">,
    forOrgSettings?: Toolset[],
  ): Promise<(toolId: string) => ToolRules> {
    const orgSets = forOrgSettings ?? (await scoped.forOrgSettings(space.orgId));
    const orgSpecs = specsOf([...settable(), ...orgSets]);
    const orgTools = new Set(orgSpecs.map((spec) => spec.name));
    const asking = new Set(
      orgSpecs.filter((spec) => spec.byDefault === "ask").map((spec) => spec.name),
    );
    const org = await settings.inOrg(space.orgId);
    const own = await settings.inSpace(space.id);
    const byId = new Map((await policies.inOrg(space.orgId)).map((policy) => [policy.id, policy]));
    const policyRule = (id: string, spaceOk: boolean) => {
      const policy = byId.get(id);
      if (!policy || (policy.spaceId !== null && !(spaceOk && policy.spaceId === space.id))) {
        return NOBODY;
      }
      return ruleOf(policy);
    };
    return (toolId) => {
      if (isFixed(toolId)) return { off: false, rule: ruleFor([OPEN]) };
      const fromOrg = orgTools.has(toolId);
      const inOrg = fromOrg ? org.get(toolId) : undefined;
      const inSpace = own.get(toolId);
      const rules: Rule[] = [];
      const unset = asking.has(toolId) ? ASKING : OPEN;
      if (fromOrg) rules.push(inOrg && inOrg !== TOOL_OFF ? policyRule(inOrg, false) : unset);
      if (inSpace && inSpace !== TOOL_OFF) rules.push(policyRule(inSpace, true));
      else if (!fromOrg) rules.push(OPEN);
      return { off: inOrg === TOOL_OFF || inSpace === TOOL_OFF, rule: ruleFor(rules) };
    };
  }

  // What the space has of tools now, read once for what is asked of them together: its toolsets,
  // what applies to each tool, what orgs and spaces add, and what the toolsets that load read.
  async function toolsIn(space: Pick<Space, "id" | "orgId">): Promise<SpaceTools> {
    let read: Promise<OrgSettings> | undefined;
    const org = options.orgSettings
      ? () => (read ??= options.orgSettings!(space.orgId))
      : undefined;
    const added = await scoped.readIn(space, org);
    const rules = await rulesIn(space, added.forOrgSettings);
    const loaded = new Map<string, unknown>();
    for (const set of toolsets) if (set.load) loaded.set(set.id, await set.load(space, org));
    return {
      ...(org && { org }),
      sets: await usedIn(space, added, rules, loaded),
      rules,
      added,
      every: specsOf([...toolsets, ...added.forSpaceSettings]),
      loaded,
    };
  }

  // The tools the thread's agent may call: those its space offers, not off there, narrowed by
  // whoever narrows them for the thread.
  async function offered(space: Pick<Space, "id" | "orgId">, thread: Thread, now?: SpaceTools) {
    const { sets, rules } = now ?? (await toolsIn(space));
    let specs = specsOf(sets).filter((spec) => !rules(spec.name).off);
    for (const narrow of narrowers) specs = await narrow(thread, specs);
    return specs;
  }

  // How much a call needs: as the tool says, raised where the tool's rules ask more.
  async function riskOf(
    space: Pick<Space, "id" | "orgId">,
    spec: AnyToolSpec,
    input: unknown,
    model: string | null,
    now?: Pick<SpaceTools, "rules">,
  ): Promise<ToolRisk> {
    return riskUnder(
      await spec.risk(input, { model, orgId: space.orgId }),
      (now?.rules ?? (await rulesIn(space)))(spec.name).rule,
    );
  }

  // The person as the rule sees them: whether they can post in the thread as they reach it now,
  // and the groups they are active in now.
  // The person before the thread's tools; how they come to it, when already read for them in its
  // space's org, is not read again.
  async function personIn(
    userId: string,
    thread: Thread,
    space: Space,
    via?: Access | null,
  ): Promise<Person> {
    const how =
      via !== undefined
        ? via
        : ((await access.of({ userId, orgId: space.orgId }, thread))?.via ?? null);
    return personOf(userId, canPostIn(how), await directory.groupIdsOf(space.orgId, userId));
  }

  // A pending request keeps its history, but decisions follow the tool's current policy.
  async function riskForCall(
    row: Pick<ToolRow, "toolId" | "input" | "risk">,
    space: Pick<Space, "id" | "orgId">,
    model: string | null = null,
    now?: CallTools,
  ): Promise<ToolRisk> {
    const spec = (await everyIn(space, now)).find((tool) => tool.name === row.toolId);
    const parsed = spec?.input.safeParse(row.input);
    return spec && parsed?.success ? await riskOf(space, spec, parsed.data, model, now) : row.risk;
  }

  // Whether the call waits for an answer rather than a decision.
  async function asks(
    row: Pick<ToolRow, "toolId">,
    space: Pick<Space, "id" | "orgId">,
    now?: Pick<SpaceTools, "every">,
  ) {
    const spec = (await everyIn(space, now)).find((tool) => tool.name === row.toolId);
    return spec?.waitsFor === "answer";
  }

  // Whether a call of the tool may move to the background: any but those that say not and those
  // that ask, as far as the space knows the tool.
  async function movable(
    row: Pick<ToolRow, "toolId">,
    space: Pick<Space, "id" | "orgId">,
    now?: Pick<SpaceTools, "every">,
  ) {
    const spec = (await everyIn(space, now)).find((tool) => tool.name === row.toolId);
    return spec?.movable !== false && spec?.waitsFor !== "answer";
  }

  // Where the call stands for the person: whether it waits on people, for a decision or for
  // answers, and whether they may act on it now: approve or deny it, or answer or skip its
  // questions. Every screen and action asks this, so they agree.
  // `read`, when given, holds what was read already for other calls: the space's tools and the
  // person as they reach the thread.
  async function callState(
    userId: string,
    row: CallView,
    words: readonly Word[],
    thread: Thread,
    space: Space,
    model: string | null,
    read?: { now: CallTools; person: () => Promise<Person> },
  ): Promise<CallState> {
    const now = read?.now ?? (await callTools(space));
    const risk = await riskForCall(row, space, model, now);
    if (row.state !== "waiting") return { waitsFor: null, canAct: false, risk };
    const waitsFor = (await asks(row, space, now)) ? "answer" : "decision";
    const canAct = (waitsFor === "answer" ? mayAnswer : mayApprove)(
      await (read?.person() ?? personIn(userId, thread, space)),
      now.rules(row.toolId).rule,
      risk,
      lastWriter(words),
    );
    return { waitsFor, canAct, risk };
  }

  // What a call's state is decided with of the space's tools: every tool it may have called and
  // the rules on each, without what only the agent's own requests need.
  async function callTools(space: Pick<Space, "id" | "orgId">): Promise<CallTools> {
    const added = await scoped.readIn(space);
    return {
      every: specsOf([...toolsets, ...added.forSpaceSettings]),
      rules: await rulesIn(space, added.forOrgSettings),
    };
  }

  // Calls' states as one reader sees them across a request: each space's tools read once, and the
  // reader as they reach each thread tree read once, a subagent's thread as its starter's. `known`
  // is how they reach one tree, when already read in its space's org.
  function callStates(userId: string, known?: { tree: string; via: Access | null }) {
    const spaces = new Map<string, Promise<CallTools>>();
    const people = new Map<string, Promise<Person>>();
    const toolsOf = (space: Pick<Space, "id" | "orgId">) => {
      const found = spaces.get(space.id) ?? callTools(space);
      spaces.set(space.id, found);
      return found;
    };
    const person = (thread: Thread, space: Space) => {
      const tree = thread.rootThreadId ?? thread.id;
      const found =
        people.get(tree) ??
        personIn(userId, thread, space, tree === known?.tree ? known.via : undefined);
      people.set(tree, found);
      return found;
    };
    return {
      toolsOf,
      person,
      async of(
        row: CallView,
        words: readonly Word[],
        thread: Thread,
        space: Space,
        model: string | null,
      ) {
        return callState(userId, row, words, thread, space, model, {
          now: await toolsOf(space),
          person: async () => person(thread, space),
        });
      },
    };
  }

  // The words the model read, messages and answers, each with whether its writer can post now and
  // whether they may use the tool directly under the rule.
  async function influenceOf(
    words: readonly Word[],
    thread: Thread,
    space: Space,
    rule: ToolRule,
    people: People = new Map(),
  ) {
    const influence: Influence[] = [];
    for (const { seq, userId } of words) {
      const person = await personOnce(people, userId, thread, space);
      influence.push({ seq, userId, canPost: person.canPost, canUse: canUse(person, rule) });
    }
    return influence;
  }

  // The person as the rule sees them, read once for whatever is judged together.
  async function personOnce(people: People, userId: string, thread: Thread, space: Space) {
    const found = people.get(userId) ?? personIn(userId, thread, space);
    people.set(userId, found);
    return found;
  }

  // What each tool the space may have called is called now, with its toolset, those called under
  // a former id among them.
  async function namesNow(
    space: Pick<Space, "id" | "orgId">,
    now?: SpaceTools,
  ): Promise<(toolId: string) => ToolNames | null> {
    const names = new Map<string, ToolNames>();
    const added = now?.added.forSpaceSettings ?? (await scoped.forSpaceSettings(space));
    for (const toolset of [...toolsets, ...added]) {
      for (const spec of toolset.tools) {
        if (names.has(spec.name)) continue;
        names.set(spec.name, { title: spec.title ?? spec.name, toolset: toolset.title });
      }
    }
    return (toolId) => names.get(toolIdNow(toolId)) ?? null;
  }

  // Says a call's input in a few words, where its tool is one of the space's that does.
  async function summariesIn(space: Pick<Space, "id" | "orgId">) {
    const saying = (await everyIn(space)).filter((tool) => tool.summary);
    return async (row: Pick<ToolRow, "toolId" | "input">) => {
      const spec = saying.find((tool) => tool.name === toolIdNow(row.toolId));
      const parsed = spec?.input.safeParse(row.input);
      return (spec && parsed?.success && (await spec.summary?.(parsed.data, space))) || null;
    };
  }

  // What each call is called where it shows: as its tool is called now; else as it was when the
  // call was asked for; else by what the model knows it by, where what added it is still there;
  // else by its id, or for an MCP server's tool, its own name there; a tool that says its input in
  // a few words says it.
  function namesIn(space: Pick<Space, "id" | "orgId"> | null) {
    let now: ((toolId: string) => ToolNames | null) | undefined;
    let said: Awaited<ReturnType<typeof summariesIn>> | undefined;
    return async (
      row: Pick<ToolRow, "toolId" | "input" | "state" | "title" | "toolset"> & {
        output?: ToolRow["output"];
      },
    ): Promise<CallNames> => {
      now ??= space ? await namesNow(space) : () => null;
      const names = now(row.toolId) ??
        (row.title ? { title: row.title, toolset: row.toolset ?? null } : null) ??
        (await scoped.named(row.toolId)) ?? {
          title: mcpToolOf(row.toolId)?.name ?? row.toolId,
          toolset: null,
        };
      said ??= space ? await summariesIn(space) : async () => Promise.resolve(null);
      const summary = await said(row);
      return summary ? { ...names, summary } : names;
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
        ...(spec.byDefault && { byDefault: spec.byDefault }),
      })),
    };
  }

  return {
    // Adds a toolset of Mage's own, after those before it, or what orgs and spaces add. Each of
    // Mage's own has an id of its own, and its tools' names start with it, so no two of them can
    // offer a tool by the same name. None is under mcp.*, which is MCP servers' own, so no
    // server's tool can clash with its tools either.
    register(toolset: Toolset | ScopedToolsets) {
      if (!("id" in toolset)) {
        scoped = toolset;
        return;
      }
      if (toolsets.some((other) => other.id === toolset.id)) {
        throw new Error(`Two of Mage's own toolsets are named ${toolset.id}`);
      }
      const stray = toolset.tools.find((spec) => !spec.name.startsWith(`${toolset.id}.`));
      if (toolset.id.split(".")[0] === "mcp" || stray) {
        throw new Error(`${stray?.name ?? toolset.id} is outside its toolset's names`);
      }
      toolsets.push(toolset);
      if (toolset.present) presenters.push(toolset.present.bind(toolset));
    },

    // Narrows the tools a thread's agent may call, after those that narrow them before.
    narrow(fn: (thread: Thread, offered: AnyToolSpec[]) => Promise<AnyToolSpec[]>) {
      narrowers.push(fn);
    },

    // Adds what shows on calls of any tool, as a job does.
    presenter(fn: NonNullable<Toolset["present"]>) {
      presenters.push(fn);
    },

    // What the page's calls show the reader: each presenter asked once, what they say merged.
    async present(reader: Reader, rows: readonly ToolRow[]) {
      const each = await Promise.all(presenters.map(async (present) => present(reader, rows)));
      return (row: ToolRow): CallPresentation => {
        const merged: CallPresentation = {};
        for (const one of each) {
          const shown = one(row);
          if (!shown) continue;
          Object.assign(merged, shown, {
            ...((merged.names || shown.names) && { names: { ...merged.names, ...shown.names } }),
            ...((merged.live || shown.live) && { live: true }),
          });
        }
        return merged;
      };
    },

    // The name of the tool that searches the tools left out of a run's requests.
    searchTool() {
      return specsOf(toolsets).find((spec) => spec.deferral === "search")?.name ?? null;
    },

    // Turns tools on for the rest of the thread, by the call that searched for them; inside the
    // write that records it.
    async turnOn(threadId: string, callId: string, toolIds: readonly string[]) {
      await options.threadTools.turnOn(threadId, callId, toolIds);
    },

    // The tools the thread turned on, in the order it did.
    turnedOn: async (threadId: string) => options.threadTools.on(threadId),

    // The tool in the org's toolsets, or in the space's when one is given.
    async find(orgId: string, id: string, space?: Pick<Space, "id" | "orgId">) {
      const sets = space ? await settingsInSpace(space) : await settingsInOrg(orgId);
      return specsOf(sets).find((spec) => spec.name === id) ?? null;
    },

    async ids(space: Pick<Space, "id" | "orgId">) {
      return specsOf(await inSpace(space)).map((spec) => spec.name);
    },

    // Every tool's definition in the space, as people see it, each named with its toolset: Mage's
    // own with theirs, an MCP server's with the server.
    async definitions(space: Pick<Space, "id" | "orgId">): Promise<ToolDefinition[]> {
      return definitionsOf(await inSpace(space));
    },

    toolsIn,
    offered,
    riskOf,
    namesNow,
    namesIn,

    // The tools the space offers from MCP servers, which a run may leave out of its requests until
    // the model turns them on, each as the model knows it.
    async fromServers(
      space: Pick<Space, "id" | "orgId">,
      names: ModelNames,
      now?: SpaceTools,
    ): Promise<DeferredTool[]> {
      const { sets, rules } = now ?? (await toolsIn(space));
      return sets.flatMap((toolset) =>
        toolset.source !== "mcp"
          ? []
          : toolset.tools
              .filter((spec) => !rules(spec.name).off)
              .map((spec) => {
                const { inputSchema, outputSchema } = definitionOf(spec);
                return {
                  id: spec.name,
                  name: names.toModel(spec.name),
                  server: toolset.title,
                  prefix: toolset.prefix ?? "",
                  description: textOf(spec.description, (id) => id),
                  inputSchema,
                  ...(outputSchema && { outputSchema }),
                };
              }),
      );
    },

    // What the toolsets on in the space tell the agent.
    async guidanceIn(
      space: Pick<Space, "id" | "orgId">,
      now?: SpaceTools,
    ): Promise<ToolsetGuidance[]> {
      return (now?.sets ?? (await inSpace(space))).flatMap((toolset) => {
        if (!toolset.guidance) return [];
        const prefix = toolset.prefix ?? namespaceOf(toolset.tools);
        return [{ name: toolset.title, ...(prefix && { prefix }), text: toolset.guidance }];
      });
    },

    // The names the model knows the space's tools by, those it does not offer now among them, for
    // calls made before.
    async modelNames(space: Pick<Space, "id" | "orgId">, now?: SpaceTools): Promise<ModelNames> {
      const names = modelToolNames(
        (await everyIn(space, now)).map((spec) => ({
          id: spec.name,
          name: spec.modelName ?? spec.name,
        })),
      );
      const ids = new Map([...names].map(([id, name]) => [name, id]));
      return {
        toModel: (id) => names.get(id) ?? id,
        fromModel: (name) => ids.get(name),
        known: (id) => names.has(id),
      };
    },

    // The name the model calls a tool by in text written for it, as providers spell it.
    textNamer(names: ModelNames) {
      return (id: string) => {
        if (!names.known(id)) options.unknownName?.(id);
        return wireToolName(names.toModel(id));
      };
    },
    riskForCall,
    callState,
    callStates,
    // The calls' states as the reader of a thread sees them, how they reach its tree already read
    // when the access rule read it in its space's org.
    callStatesFor(read: Pick<Reader, "principal" | "space" | "thread" | "via">) {
      const sameOrg = !!read.space && read.principal.orgId === read.space.orgId;
      return callStates(
        read.principal.userId,
        sameOrg ? { tree: read.thread.rootThreadId ?? read.thread.id, via: read.via } : undefined,
      );
    },
    callTools,
    rulesIn,

    // The person's own connection that a call of the tool with this input would run with, for a
    // call that uses each person's own credentials.
    async connectionFor(
      space: Pick<Space, "id" | "orgId">,
      toolId: string,
      userId: string,
      input: unknown,
      now?: Pick<SpaceTools, "every">,
    ): Promise<ToolConnection | null> {
      const spec = (await everyIn(space, now)).find((tool) => tool.name === toolId);
      const parsed = spec?.input.safeParse(input);
      if (!spec?.connection || !parsed?.success) return null;
      return (await (await spec.connection(parsed.data, space))?.(userId)) ?? null;
    },

    // What the person is shown of the space's tools in the thread: each tool's definition, as
    // `definitions` gives it, and their level for it, whether they may use it without approval.
    async shownTo(
      userId: string,
      thread: Thread,
      space: Space,
      via?: Access | null,
      read?: Person,
    ): Promise<{ levels: Record<string, ToolLevel>; definitions: ToolDefinition[] }> {
      const person = read ?? (await personIn(userId, thread, space, via));
      const { rules, sets } = await toolsIn(space);
      return {
        levels: Object.fromEntries(
          specsOf(sets).map((spec) => [
            spec.name,
            canUse(person, rules(spec.name).rule) ? "run" : "approve",
          ]),
        ),
        definitions: definitionsOf(sets),
      };
    },

    // The toolsets of the org, with each tool's definition; a fixed one is always on.
    async toolsetsInOrg(orgId: string) {
      const switches = await settings.toolsetsInOrg(orgId);
      const options = await settings.optionsInOrg(orgId);
      return (await shownInOrg(orgId)).map((toolset) => ({
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
    async optionOn(space: Pick<Space, "id" | "orgId">, toolsetId: string, option: string) {
      return (
        (await settings.optionsInOrg(space.orgId)).get(toolsetId)?.get(option) === true &&
        (await settings.optionsInSpace(space.id)).get(toolsetId)?.get(option) !== false
      );
    },

    // The space's: those the org offers it as the org's, and the rest as its own.
    async toolsetsInSpace(space: Pick<Space, "id" | "orgId">) {
      const org = new Set(
        [...toolsets, ...(await scoped.forOrgSettings(space.orgId))].map((toolset) => toolset.id),
      );
      const orgSwitches = await settings.toolsetsInOrg(space.orgId);
      const switches = await settings.toolsetsInSpace(space.id);
      const orgOptions = await settings.optionsInOrg(space.orgId);
      const options = await settings.optionsInSpace(space.id);
      return (await shownInSpace(space)).map((toolset) => ({
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

    // The tools as the model is told about them, naming other tools as `named` does.
    forModel(tools: AnyToolSpec[], named?: (toolId: string) => string): ModelTool[] {
      return tools.map((spec) => modelToolOf(spec, named));
    },

    // Whether a call of the tool, with the risk the tool itself declares for it, runs now, on a
    // standing approval, or waits; for a tool whose calls run with a person's own login, as whom.
    async evaluate(
      words: readonly Word[],
      vouches: readonly Vouch[],
      thread: Thread,
      space: Space,
      toolId: string,
      declared: ToolRisk,
      input: unknown,
      now?: SpaceTools,
      // The people read already for calls judged together in the thread.
      people: People = new Map(),
    ): Promise<Decision> {
      const { rule } = (now?.rules ?? (await rulesIn(space)))(toolId);
      const spec = (await everyIn(space, now)).find((tool) => tool.name === toolId);
      const connection = (await spec?.connection?.(input, space)) ?? null;
      // The vouches given for now themselves, not the calls that later ran on them.
      const standing: Approval[] = await Promise.all(
        vouches
          .filter((vouch) => vouch.toolId === toolId)
          .map(async (vouch) => ({
            atSeq: vouch.seq,
            by: vouch.by,
            eligible: mayApprove(
              await personOnce(people, vouch.by, thread, space),
              rule,
              "normal",
              null,
            ),
            callId: vouch.callId,
          })),
      );
      return decide({
        declared,
        rule,
        influence: await influenceOf(words, thread, space, rule, people),
        standing,
        ...(connection && {
          connected: async (userId: string) => (await connection(userId)).connected,
        }),
      });
    },

    asks,
    movable,

    // The one place a tool runs: direct calls and background calls both go through it.
    run: (spec: AnyToolSpec, input: unknown, ctx: ToolContext) => spec.run(input, ctx),

    // Whether the answer given to the call still holds, just before it runs: its writer may still
    // use or approve the tool, as things stood when they answered, and everyone who wrote after
    // it can still post in the thread.
    async answerHolds(
      row: CallView,
      words: readonly Word[],
      thread: Thread,
      space: Space,
      now?: SpaceTools,
    ) {
      if (!row.answers || !row.decision?.allow) return false;
      const { rule } = (now?.rules ?? (await rulesIn(space)))(row.toolId);
      const { by, seq: atSeq } = row.decision;
      const eligible = mayAnswer(
        await personIn(by.userId, thread, space),
        rule,
        await riskForCall(row, space, null, now),
        lastWriter(words.filter((word) => word.seq < atSeq)),
      );
      return holds(
        { atSeq, by: by.userId, eligible },
        await influenceOf(words, thread, space, rule),
        stillPosts,
      );
    },

    // Whether the vouch given for the call still holds, just before it runs: its giver may still
    // approve it under the tool's rule now, independently where that applies, and everyone who
    // wrote after it can still post in the thread.
    async approvalHolds(
      row: CallView,
      words: readonly Word[],
      thread: Thread,
      space: Space,
      given?: ToolRisk,
      now?: SpaceTools,
    ) {
      const risk = given ?? (await riskForCall(row, space, null, now));
      if (!row.decision?.allow) return false;
      if (risk === "review" && row.decision.scope !== "once") return false;
      const { rule } = (now?.rules ?? (await rulesIn(space)))(row.toolId);
      const { by, seq: atSeq } = row.decision;
      const eligible = mayApprove(
        await personIn(by.userId, thread, space),
        rule,
        risk,
        lastWriter(words),
      );
      return holds(
        { atSeq, by: by.userId, eligible },
        await influenceOf(words, thread, space, rule),
        stillPosts,
      );
    },
  };
}

export interface ToolDecisionsOptions {
  tools: Pick<Tools, "find" | "toolsetsInOrg" | "toolsetsInSpace">;
  spaces: Pick<Spaces, "require">;
  settings: ToolSettingStore;
  policies: Pick<ToolPolicyStore, "find">;
}

export type ToolDecisions = ReturnType<typeof createToolDecisions>;

const OWNERS_ONLY = "Only the organization's owners can do this";

// What orgs and spaces set their tools to.
export function createToolDecisions(options: ToolDecisionsOptions) {
  const { tools, spaces, settings, policies } = options;

  async function known(orgId: string, toolId: string, space?: Space) {
    if (!(await tools.find(orgId, toolId, space))) throw new ServiceError(404, "Tool not found");
  }

  // A policy the scope may set its tools to: the org's own, or for a space also its own.
  async function usable(policyId: string | null, orgId: string, spaceId: string | null) {
    if (policyId === null || policyId === TOOL_OFF) return;
    const policy = await policies.find(policyId);
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
    toolsets: Awaited<ReturnType<Tools["toolsetsInSpace"]>>,
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
      tools: toolset.tools.map(({ definition, fixed, byDefault }) => ({
        id: definition.name,
        definition,
        ...(fixed
          ? { orgPolicy: null, policy: null, fixed }
          : { ...assignmentsOf(definition.name, toolset.scope), ...(byDefault && { byDefault }) }),
      })),
    }));
  }

  return {
    // The toolsets with what the org set each tool to.
    async orgTools(principal: Principal): Promise<ToolsetSetting[]> {
      const org = await settings.inOrg(principal.orgId);
      return settingsOf(await tools.toolsetsInOrg(principal.orgId), (id) => {
        const policy = org.get(id) ?? null;
        return { orgPolicy: policy, policy };
      });
    },

    async setOrgTools(principal: Principal, change: ToolPolicyChange) {
      if (principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
      for (const id of change.toolIds) await known(principal.orgId, id);
      await usable(change.policy, principal.orgId, null);
      await settings.setInOrg(principal.orgId, change.toolIds, change.policy);
    },

    // The toolsets with what the org and the space set each tool to.
    async spaceTools(principal: Principal, spaceId: string): Promise<ToolsetSetting[]> {
      const space = await spaces.require(principal, spaceId, "manage");
      const org = await settings.inOrg(space.orgId);
      const own = await settings.inSpace(space.id);
      return settingsOf(await tools.toolsetsInSpace(space), (id, scope) => ({
        orgPolicy: scope === "org" ? (org.get(id) ?? null) : null,
        policy: own.get(id) ?? null,
      }));
    },

    async setSpaceTools(principal: Principal, spaceId: string, change: ToolPolicyChange) {
      const space = await spaces.require(principal, spaceId, "manage");
      for (const id of change.toolIds) await known(space.orgId, id, space);
      await usable(change.policy, space.orgId, space.id);
      await settings.setInSpace(space.id, change.toolIds, change.policy);
    },

    async setOrgToolset(principal: Principal, toolsetId: string, enabled: boolean) {
      if (principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
      const toolset = (await tools.toolsetsInOrg(principal.orgId)).find(
        (set) => set.id === toolsetId && set.source === "builtin" && !set.fixed,
      );
      if (!toolset) throw new ServiceError(404, "Toolset not found");
      await settings.setToolsetInOrg(principal.orgId, toolsetId, enabled);
    },

    // Turns the built-in toolset's option on or off for the org's spaces.
    async setOrgToolsetOption(
      principal: Principal,
      toolsetId: string,
      option: string,
      enabled: boolean,
    ) {
      if (principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
      const toolset = (await tools.toolsetsInOrg(principal.orgId)).find(
        (set) => set.id === toolsetId,
      );
      if (!toolset?.options?.some((one) => one.id === option)) {
        throw new ServiceError(404, "Option not found");
      }
      await settings.setOptionInOrg(principal.orgId, toolsetId, option, enabled);
    },

    // Turns the option off in the space, or back on while the org has it on.
    async setSpaceToolsetOption(
      principal: Principal,
      spaceId: string,
      toolsetId: string,
      option: string,
      enabled: boolean,
    ) {
      const space = await spaces.require(principal, spaceId, "manage");
      const toolset = (await tools.toolsetsInSpace(space)).find((set) => set.id === toolsetId);
      const found = toolset?.options?.find((one) => one.id === option);
      if (!found) throw new ServiceError(404, "Option not found");
      if (enabled && !found.orgEnabled) {
        throw new ServiceError(409, "The organization turned this option off");
      }
      await settings.setOptionInSpace(spaceId, toolsetId, option, enabled);
    },

    async setSpaceToolset(
      principal: Principal,
      spaceId: string,
      toolsetId: string,
      enabled: boolean,
    ) {
      const space = await spaces.require(principal, spaceId, "manage");
      const toolset = (await tools.toolsetsInSpace(space)).find(
        (set) => set.id === toolsetId && set.source === "builtin" && !set.fixed,
      );
      if (!toolset) throw new ServiceError(404, "Toolset not found");
      if (enabled && !toolset.orgEnabled)
        throw new ServiceError(409, "The organization turned this toolset off");
      await settings.setToolsetInSpace(spaceId, toolsetId, enabled);
    },
  };
}
