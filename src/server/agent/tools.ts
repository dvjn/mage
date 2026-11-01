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
import type { ToolRisk, ToolScope } from "@/shared/threads/events.ts";
import {
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
  // For a tool whose calls run with the own login of the person they run as: that person's
  // connection for it. Its calls run directly only for one connected writer; otherwise they wait
  // for an approver, who connects first and whose login the call then runs with.
  connection?(userId: string): ToolConnection;
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
  const scoped = options.scoped ?? {
    inSpace: () => [],
    forOrgSettings: () => [],
    forSpaceSettings: () => [],
  };

  function settingsInOrg(orgId: string) {
    return [...toolsets, ...scoped.forOrgSettings(orgId)];
  }

  function settingsInSpace(space: Pick<Space, "id" | "orgId">) {
    return [...toolsets, ...scoped.forSpaceSettings(space)];
  }

  // The toolsets the space has: Mage's own that are on and of use there, and those of what the org
  // and the space added.
  function inSpace(space: Pick<Space, "id" | "orgId">) {
    const org = settings.toolsetsInOrg(space.orgId);
    const own = settings.toolsetsInSpace(space.id);
    return [
      ...toolsets.filter(
        (set) =>
          org.get(set.id) !== false && own.get(set.id) !== false && (set.usefulIn?.(space) ?? true),
      ),
      ...scoped.inSpace(space),
    ];
  }

  function specsOf(sets: Toolset[]) {
    return sets.flatMap((toolset) => toolset.tools);
  }

  // What applies to each tool in the space. The org's tools take the org's policy, or are open
  // when it set none, with the space's extra rule on top; the space's own take the space's
  // policy, or are open. Off in either is off. A policy that is gone, or not the scope's to use,
  // lets nobody use the tool and nobody approve it.
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
    const spec = specsOf(settingsInSpace(space)).find((tool) => tool.name === row.toolId);
    const parsed = spec?.input.safeParse(row.input);
    return spec && parsed?.success ? riskOf(space, spec, parsed.data, model) : row.risk;
  }

  // Whether the call waits for an answer rather than a decision.
  function asks(row: Pick<ToolRow, "toolId">, space: Pick<Space, "id" | "orgId">) {
    const spec = specsOf(settingsInSpace(space)).find((tool) => tool.name === row.toolId);
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

  // The toolset with each tool's definition, and whether the org or the space has it.
  function withDefinitions(
    { tools, guidance: _guidance, ...toolset }: Toolset,
    scope: "org" | "space",
  ) {
    return { ...toolset, scope, tools: tools.map(definitionOf) };
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

    // What the toolsets on in the space tell the agent.
    guidanceIn(space: Pick<Space, "id" | "orgId">) {
      return inSpace(space).flatMap((toolset) => (toolset.guidance ? [toolset.guidance] : []));
    },

    // The names the model knows the space's tools by, those it does not offer now among them, for
    // calls made before.
    modelNames(space: Pick<Space, "id" | "orgId">): ModelNames {
      const names = modelToolNames(
        specsOf(settingsInSpace(space)).map((spec) => ({
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

    // The person's own connection that a call of the tool would run with, for a tool that uses
    // each person's own credentials.
    connectionFor(
      space: Pick<Space, "id" | "orgId">,
      toolId: string,
      userId: string,
    ): ToolConnection | null {
      const spec = specsOf(settingsInSpace(space)).find((tool) => tool.name === toolId);
      return spec?.connection?.(userId) ?? null;
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

    // The toolsets of the org, with each tool's definition.
    toolsetsInOrg(orgId: string) {
      const switches = settings.toolsetsInOrg(orgId);
      return settingsInOrg(orgId).map((toolset) => ({
        ...withDefinitions(toolset, "org"),
        ...(toolset.source === "builtin" && {
          orgEnabled: switches.get(toolset.id) !== false,
          enabled: switches.get(toolset.id) !== false,
        }),
      }));
    },

    // The space's: those the org offers it as the org's, and the rest as its own.
    toolsetsInSpace(space: Pick<Space, "id" | "orgId">) {
      const org = new Set(settingsInOrg(space.orgId).map((toolset) => toolset.id));
      const orgSwitches = settings.toolsetsInOrg(space.orgId);
      const switches = settings.toolsetsInSpace(space.id);
      return settingsInSpace(space).map((toolset) => ({
        ...withDefinitions(toolset, org.has(toolset.id) ? "org" : "space"),
        ...(toolset.source === "builtin" && {
          orgEnabled: orgSwitches.get(toolset.id) !== false,
          enabled: orgSwitches.get(toolset.id) !== false && switches.get(toolset.id) !== false,
        }),
      }));
    },

    // The tools as the model is told about them.
    forModel(tools: AnyToolSpec[]): ModelTool[] {
      return tools.map((spec) => ({
        id: spec.name,
        description: spec.description,
        inputSchema: definitionOf(spec).inputSchema,
      }));
    },

    // Whether a call of the tool, with the risk the tool itself declares for it, runs now, on a
    // standing approval, or waits; for a tool whose calls run with a person's own login, as whom.
    decide(
      rows: readonly TranscriptRow[],
      thread: Thread,
      space: Space,
      toolId: string,
      declared: ToolRisk,
    ): Decision {
      const { rule } = rulesIn(space)(toolId);
      const spec = specsOf(settingsInSpace(space)).find((tool) => tool.name === toolId);
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
        ...(spec?.connection && {
          connected: (userId: string) => !!spec.connection?.(userId).connected,
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
      tools: toolset.tools.map((definition) => ({
        id: definition.name,
        definition,
        ...assignmentsOf(definition.name, toolset.scope),
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
        const connection = tools.connectionFor(space, call.toolId, principal.userId);
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
        .find((set) => set.id === toolsetId && set.source === "builtin");
      if (!toolset) throw new ServiceError(404, "Toolset not found");
      settings.setToolsetInOrg(principal.orgId, toolsetId, enabled);
    },

    setSpaceToolset(principal: Principal, spaceId: string, toolsetId: string, enabled: boolean) {
      const space = spaces.require(principal, spaceId, "manage");
      const toolset = tools
        .toolsetsInSpace(space)
        .find((set) => set.id === toolsetId && set.source === "builtin");
      if (!toolset) throw new ServiceError(404, "Toolset not found");
      if (enabled && !toolset.orgEnabled)
        throw new ServiceError(409, "The organization turned this toolset off");
      settings.setToolsetInSpace(spaceId, toolsetId, enabled);
    },
  };
}
