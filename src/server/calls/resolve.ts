// Which tool a call made by name is, for calls no model step asks for directly: a job's and a
// script's. The name may be the tool's id, its model name or that name as providers spell it.
// What decides it is read once for every name resolved together.

import type { Space } from "@/server/spaces/service.ts";
import type { Thread } from "@/server/threads/types.ts";
import type { AnyToolSpec, ModelNames, SpaceTools, Tools } from "@/server/tools/registry.ts";
import { notOnYet } from "@/server/tools/search.ts";
import { wireToolName } from "@/shared/tools.ts";

// A call the tools refuse, with what the model is told and why: no tool by the name may be called,
// it is an MCP server's tool the thread has not turned on, or the caller refuses it.
export class ToolRefusal extends Error {
  readonly reason: "missing" | "notOn" | "refused";
  readonly toolId: string | undefined;

  constructor(message: string, reason: ToolRefusal["reason"] = "refused", toolId?: string) {
    super(message);
    this.reason = reason;
    this.toolId = toolId;
  }
}

// What names are resolved against: the space's tools now, those the thread's agent may call, their
// model names, and the MCP servers' tools the thread has not turned on.
export interface Callable {
  now: SpaceTools;
  offered: AnyToolSpec[];
  names: ModelNames;
  notOn: ReadonlySet<string>;
}

export async function callableIn(
  tools: Pick<Tools, "toolsIn" | "offered" | "modelNames" | "fromServers" | "turnedOn">,
  thread: Thread,
  space: Pick<Space, "id" | "orgId">,
): Promise<Callable> {
  const now = await tools.toolsIn(space);
  const names = await tools.modelNames(space, now);
  const on = new Set((await tools.turnedOn(thread.id)).map((tool) => tool.id));
  const servers = await tools.fromServers(space, names, now);
  return {
    now,
    offered: await tools.offered(space, thread, now),
    names,
    notOn: new Set(servers.filter((tool) => !on.has(tool.id)).map((tool) => tool.id)),
  };
}

// The tool the agent may call by the name; refused when none is, or its server's tool is not on.
export function toolNamed(callable: Callable, name: string): AnyToolSpec {
  const { offered, names } = callable;
  const wanted =
    names.fromModel(name) ??
    offered.find((one) => one.name === name || wireToolName(names.toModel(one.name)) === name)
      ?.name ??
    name;
  const spec = offered.find((one) => one.name === wanted);
  if (!spec) throw new ToolRefusal(`No tool is named ${name} here.`, "missing");
  if (callable.notOn.has(spec.name)) {
    throw new ToolRefusal(notOnYet(spec.name, names.toModel), "notOn", spec.name);
  }
  return spec;
}
