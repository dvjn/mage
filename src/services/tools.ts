// The agent's tools in each thread: which ones its space offers, each person's level for them, and
// whether a call runs now, runs on a standing approval or waits; people's decisions on calls that
// wait; and the mode orgs and spaces set for each tool. Mage's own tools and the toolsets an org
// adds are in every space of the org; a space may add toolsets of its own. An org allows a tool,
// has it ask each time, or blocks it, for all its spaces; a space can only make that stricter for
// itself, and sets its own toolsets' tools as it likes.

import * as z from "zod";

import type { EventBus } from "@/ports/event-bus.ts";
import type { Principal } from "@/ports/identity.ts";
import type { ModelTool } from "@/ports/model-gateway.ts";
import type { RunStore } from "@/ports/runs.ts";
import type { Space, SpaceStore } from "@/ports/spaces.ts";
import type { Thread, ThreadStore } from "@/ports/threads.ts";
import type {
  AnyToolSpec,
  ScopedToolsets,
  ToolLevel,
  ToolMode,
  ToolSettingStore,
  Toolset,
} from "@/ports/tools.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { ThreadAccess } from "@/services/thread-access.ts";
import { eventSummary, type ThreadLog } from "@/services/thread-log.ts";
import {
  type Approval,
  decide,
  holds,
  type Influence,
  levelOf,
} from "@/services/tool-authority.ts";
import type { ToolRisk, ToolScope } from "@/shared/threads.ts";
import {
  strictest,
  type ToolDefinition,
  type ToolModeChange,
  type ToolsetSetting,
} from "@/shared/tools.ts";
import { type ToolRow, type TranscriptRow, transcriptOf } from "@/shared/transcript.ts";

export type { AnyToolSpec };

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

export interface ToolsOptions {
  // Mage's own.
  toolsets: Toolset[];
  // Those orgs and spaces add.
  scoped?: ScopedToolsets;
  settings: ToolSettingStore;
  access: Pick<ThreadAccess, "of">;
}

export type Tools = ReturnType<typeof createTools>;

export function createTools(options: ToolsOptions) {
  const { toolsets, settings, access } = options;
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

  // The toolsets the space has: Mage's own, and those of what the org and the space added.
  function inSpace(space: Pick<Space, "id" | "orgId">) {
    return [...toolsets, ...scoped.inSpace(space)];
  }

  function specsOf(sets: Toolset[]) {
    return sets.flatMap((toolset) => toolset.tools);
  }

  // Each tool's mode in the org: as it set, else allowed.
  function orgModes(orgId: string) {
    const set = settings.inOrg(orgId);
    return new Map(
      specsOf(settingsInOrg(orgId)).map((spec) => [
        spec.name,
        set.get(spec.name) ?? ("allow" as ToolMode),
      ]),
    );
  }

  // Each tool's mode in the space: the org's, made stricter where the space set one. The space's
  // own tools are the org's to allow.
  function spaceModes(space: Pick<Space, "id" | "orgId">) {
    const org = orgModes(space.orgId);
    const set = settings.inSpace(space.id);
    return new Map(
      specsOf(settingsInSpace(space)).map((spec) => {
        const own = set.get(spec.name);
        const inOrg = org.get(spec.name) ?? "allow";
        return [spec.name, own ? strictest(inOrg, own) : inOrg];
      }),
    );
  }

  // The tools the space offers: those not blocked there.
  function offered(space: Pick<Space, "id" | "orgId">) {
    const modes = spaceModes(space);
    return specsOf(inSpace(space)).filter((spec) => modes.get(spec.name) !== "block");
  }

  // How much a call can do: as the tool says, or always asking where the space has it ask.
  function riskOf(
    space: Pick<Space, "id" | "orgId">,
    spec: AnyToolSpec,
    input: unknown,
    model: string | null,
  ): ToolRisk {
    if (spaceModes(space).get(spec.name) === "ask") return "ask";
    return spec.risk(input, { model });
  }

  // The person's level in the thread, as they reach it now.
  function levelFor(userId: string, thread: Thread, space: Space): ToolLevel {
    return levelOf(access.of({ userId, orgId: space.orgId }, thread));
  }

  // The words the model read, each with its writer's level now.
  function influenceOf(rows: readonly TranscriptRow[], thread: Thread, space: Space) {
    const levels = new Map<string, ToolLevel>();
    const influence: Influence[] = [];
    for (const row of rows) {
      if (row.kind !== "human") continue;
      const { userId } = row.author;
      let level = levels.get(userId);
      if (!level) {
        level = levelFor(userId, thread, space);
        levels.set(userId, level);
      }
      influence.push({ seq: row.seq, level });
    }
    return influence;
  }

  function approvalOf(row: ToolRow, thread: Thread, space: Space): Approval | null {
    if (!row.decision?.allow) return null;
    return {
      atSeq: row.decision.seq,
      level: levelFor(row.decision.by.userId, thread, space),
    };
  }

  // The toolset with each tool's definition, and whether the org or the space has it.
  function withDefinitions({ tools, ...toolset }: Toolset, scope: "org" | "space") {
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

    // Every tool's definition in the space, as people see it; an MCP server's tools named with
    // their server.
    definitions(space: Pick<Space, "id" | "orgId">): ToolDefinition[] {
      return inSpace(space).flatMap((toolset) =>
        toolset.tools.map((spec) => ({
          ...definitionOf(spec),
          ...(toolset.source === "mcp" && { toolset: toolset.title }),
        })),
      );
    },

    offered,
    riskOf,
    levelFor,
    orgModes,
    spaceModes,

    // The toolsets of the org, with each tool's definition.
    toolsetsInOrg(orgId: string) {
      return settingsInOrg(orgId).map((toolset) => withDefinitions(toolset, "org"));
    },

    // The space's: those the org offers it as the org's, and the rest as its own.
    toolsetsInSpace(space: Pick<Space, "id" | "orgId">) {
      const org = new Set(settingsInOrg(space.orgId).map((toolset) => toolset.id));
      return settingsInSpace(space).map((toolset) =>
        withDefinitions(toolset, org.has(toolset.id) ? "org" : "space"),
      );
    },

    // The tools as the model is told about them.
    forModel(tools: AnyToolSpec[]): ModelTool[] {
      return tools.map((spec) => ({
        id: spec.name,
        description: spec.description,
        inputSchema: definitionOf(spec).inputSchema,
      }));
    },

    // Whether a call of the tool with this risk runs now, on a standing approval, or waits.
    decide(
      rows: readonly TranscriptRow[],
      thread: Thread,
      space: Space,
      toolId: string,
      risk: ToolRisk,
    ) {
      const standing = rows
        .filter(
          (row): row is ToolRow =>
            row.kind === "tool" && row.toolId === toolId && row.decision?.scope === "for_now",
        )
        .map((row) => approvalOf(row, thread, space))
        .filter((approval) => approval !== null);
      return decide({ risk, influence: influenceOf(rows, thread, space), standing });
    },

    // Whether the approval given for the call still holds, just before it runs.
    approvalHolds(row: ToolRow, rows: readonly TranscriptRow[], thread: Thread, space: Space) {
      const approval = approvalOf(row, thread, space);
      return !!approval && holds(approval, influenceOf(rows, thread, space));
    },
  };
}

export interface ToolDecisionsOptions {
  tools: Pick<
    Tools,
    "find" | "levelFor" | "toolsetsInOrg" | "toolsetsInSpace" | "orgModes" | "spaceModes"
  >;
  access: Pick<ThreadAccess, "require">;
  threads: Pick<ThreadStore, "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  runs: Pick<RunStore, "find" | "resume">;
  spaces: Pick<Spaces, "require">;
  settings: ToolSettingStore;
  log: ThreadLog;
  bus: EventBus;
}

export type ToolDecisions = ReturnType<typeof createToolDecisions>;

const ONLY_RUNNERS = "Only people who can run this here can decide";

// People's decisions on calls that wait, and the tool switches and levels of orgs and spaces.
export function createToolDecisions(options: ToolDecisionsOptions) {
  const { tools, access, threads, spaceStore, runs, spaces, settings, log, bus } = options;

  function known(orgId: string, toolId: string, space?: Space) {
    if (!tools.find(orgId, toolId, space)) throw new ServiceError(404, "Tool not found");
  }

  // The toolsets as settings show them, with each tool's modes.
  function settingsOf(
    toolsets: ReturnType<Tools["toolsetsInSpace"]>,
    modesOf: (toolId: string) => { orgMode: ToolMode; mode: ToolMode },
  ) {
    return toolsets.map((toolset) => ({
      ...toolset,
      tools: toolset.tools.map((definition) => ({
        id: definition.name,
        definition,
        ...modesOf(definition.name),
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
        if (call.state !== "pending" || !call.waits) {
          throw new ServiceError(409, "Already decided");
        }
        if (tools.levelFor(principal.userId, thread, space) !== "run") {
          throw new ServiceError(403, ONLY_RUNNERS);
        }
        if (decision.allow && decision.scope === "for_now" && call.risk !== "normal") {
          throw new ServiceError(400, "This call can only be allowed once");
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

    // The toolsets with each tool's mode in the org.
    orgTools(principal: Principal): ToolsetSetting[] {
      const modes = tools.orgModes(principal.orgId);
      return settingsOf(tools.toolsetsInOrg(principal.orgId), (id) => ({
        orgMode: modes.get(id)!,
        mode: modes.get(id)!,
      }));
    },

    setOrgTools(principal: Principal, change: ToolModeChange) {
      if (principal.role !== "owner") {
        throw new ServiceError(403, "Only the organization's owners can do this");
      }
      for (const id of change.toolIds) known(principal.orgId, id);
      settings.setInOrg(principal.orgId, change.toolIds, change.mode);
    },

    // The toolsets with each tool's mode in the org and in the space.
    spaceTools(principal: Principal, spaceId: string): ToolsetSetting[] {
      const space = spaces.require(principal, spaceId, "manage");
      const org = tools.orgModes(space.orgId);
      const modes = tools.spaceModes(space);
      return settingsOf(tools.toolsetsInSpace(space), (id) => ({
        orgMode: org.get(id) ?? "allow",
        mode: modes.get(id)!,
      }));
    },

    setSpaceTools(principal: Principal, spaceId: string, change: ToolModeChange) {
      const space = spaces.require(principal, spaceId, "manage");
      for (const id of change.toolIds) known(space.orgId, id, space);
      settings.setInSpace(space.id, change.toolIds, change.mode);
    },
  };
}
