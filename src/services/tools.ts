// The agent's tools in each thread: which ones its space offers, each person's level for them, and
// whether a call runs now, runs on a standing approval or waits; people's decisions on calls that
// wait; and the switches and levels orgs and spaces set for them. An org turns tools off for all its
// spaces; a space turns them off for itself, and can only narrow what its org allows.

import * as z from "zod";

import type { EventBus } from "@/ports/event-bus.ts";
import type { Principal } from "@/ports/identity.ts";
import type { ModelTool } from "@/ports/model-gateway.ts";
import type { RunStore } from "@/ports/runs.ts";
import type { Space, SpaceStore } from "@/ports/spaces.ts";
import type { Thread, ThreadStore } from "@/ports/threads.ts";
import type { ToolLevel, ToolSettingStore, ToolSpec } from "@/ports/tools.ts";
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
import type { OrgTool, SpaceTool } from "@/shared/tools.ts";
import { type ToolRow, type TranscriptRow, transcriptOf } from "@/shared/transcript.ts";

// Any tool, whatever its input.
export type AnyToolSpec = ToolSpec<any>;

export interface ToolsOptions {
  specs: AnyToolSpec[];
  settings: ToolSettingStore;
  access: Pick<ThreadAccess, "of">;
}

export type Tools = ReturnType<typeof createTools>;

export function createTools(options: ToolsOptions) {
  const { specs, settings, access } = options;
  const byId = new Map(specs.map((spec) => [spec.id, spec]));

  // The tools on in the space: on in its org, and not turned off there.
  function offered(orgId: string, spaceId: string) {
    const offInOrg = settings.offInOrg(orgId);
    const inSpace = settings.inSpace(spaceId);
    return specs.filter(
      (spec) => !offInOrg.has(spec.id) && inSpace.get(spec.id)?.enabled !== false,
    );
  }

  // The person's level for the tool in the thread, as they reach it now.
  function levelFor(userId: string, thread: Thread, space: Space, toolId: string): ToolLevel {
    const setting = settings.inSpace(space.id).get(toolId);
    return levelOf(access.of({ userId, orgId: space.orgId }, thread), toolId, {
      messager: setting?.messager,
      guest: setting?.guest,
    });
  }

  // The words the model read, each with its writer's level for the tool now.
  function influenceOf(
    rows: readonly TranscriptRow[],
    thread: Thread,
    space: Space,
    toolId: string,
  ) {
    const levels = new Map<string, ToolLevel>();
    const influence: Influence[] = [];
    for (const row of rows) {
      if (row.kind !== "human") continue;
      const { userId } = row.author;
      let level = levels.get(userId);
      if (!level) {
        level = levelFor(userId, thread, space, toolId);
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
      level: levelFor(row.decision.by.userId, thread, space, row.toolId),
    };
  }

  return {
    find(id: string) {
      return byId.get(id) ?? null;
    },

    ids() {
      return specs.map((spec) => spec.id);
    },

    offered,
    levelFor,

    // The tools as the model is told about them.
    forModel(tools: AnyToolSpec[]): ModelTool[] {
      return tools.map((spec) => ({
        id: spec.id,
        description: spec.description,
        inputSchema: z.toJSONSchema(spec.input, { io: "input" }) as Record<string, unknown>,
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
      return decide({ risk, influence: influenceOf(rows, thread, space, toolId), standing });
    },

    // Whether the approval given for the call still holds, just before it runs.
    approvalHolds(row: ToolRow, rows: readonly TranscriptRow[], thread: Thread, space: Space) {
      const approval = approvalOf(row, thread, space);
      return !!approval && holds(approval, influenceOf(rows, thread, space, row.toolId));
    },
  };
}

export interface ToolDecisionsOptions {
  tools: Pick<Tools, "find" | "levelFor" | "ids">;
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

  function known(toolId: string) {
    if (!tools.find(toolId)) throw new ServiceError(404, "Tool not found");
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
        if (tools.levelFor(principal.userId, thread, space, call.toolId) !== "run") {
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

    // Every tool with whether the org has it on.
    orgTools(principal: Principal): OrgTool[] {
      const off = settings.offInOrg(principal.orgId);
      return allIds().map((id) => ({ id, enabled: !off.has(id) }));
    },

    setOrgTool(principal: Principal, toolId: string, enabled: boolean) {
      if (principal.role !== "owner") {
        throw new ServiceError(403, "Only the organization's owners can do this");
      }
      known(toolId);
      settings.setInOrg(principal.orgId, toolId, enabled);
    },

    // Every tool with whether the space and its org have it on, and its levels there.
    spaceTools(principal: Principal, spaceId: string): SpaceTool[] {
      const space = spaces.require(principal, spaceId, "manage");
      const off = settings.offInOrg(space.orgId);
      const inSpace = settings.inSpace(space.id);
      return allIds().map((id) => {
        const setting = inSpace.get(id);
        return {
          id,
          enabled: setting?.enabled ?? true,
          orgEnabled: !off.has(id),
          messager: setting?.messager ?? "run",
          guest: setting?.guest ?? levelOf({ via: "guest", spaceName: "" }, id),
        };
      });
    },

    setSpaceTool(
      principal: Principal,
      spaceId: string,
      change: { toolId: string; enabled?: boolean; messager?: ToolLevel; guest?: ToolLevel },
    ) {
      const space = spaces.require(principal, spaceId, "manage");
      known(change.toolId);
      const { toolId, ...changes } = change;
      settings.setInSpace(space.id, toolId, changes);
    },
  };

  function allIds() {
    return tools.ids();
  }
}
