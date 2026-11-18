// The calls a script or a job made, as a tree under the agent's own call that led to them: a job
// in the place of the Start that made it, the calls under a call grouped by tool, how many calls
// sit under a call and what became of them, the call running now, and what must stay open so that
// a call waiting for approval shows.

import { type CallOutcome, outcomeOf, type Standing, standingOf } from "@/shared/call-outcome.ts";
import { START_JOB } from "@/shared/jobs.ts";
import type { ShownRow, ToolRow } from "@/shared/threads/rows.ts";
import { lineKey } from "@/web/threads/transcript/row-focus";

export interface CallNode {
  // The call as it shows: a job in place of the Start that made it.
  row: ToolRow;
  // The Start whose place the job took.
  start?: ToolRow;
  calls: CallNode[];
}

// What a node is known by as it shows, the same before and after a job takes its Start's place.
export const nodeId = (node: CallNode) => node.start?.id ?? node.row.id;

// What a node's line, its calls, and a group of its calls by tool are held open by.
export const nodeLineKey = (node: CallNode) => lineKey(nodeId(node));
export const callsKey = (id: string) => `calls:${id}`;
export const toolsKey = (id: string, toolId: string) => `tools:${id}:${toolId}`;

// The calls of the rows given that another of them made, by the id of the one that made them.
export function callsUnder(rows: readonly ToolRow[]) {
  const under = new Map<string, ToolRow[]>();
  for (const row of rows) {
    if (!row.parent) continue;
    const calls = under.get(row.parent.id) ?? [];
    calls.push(row);
    under.set(row.parent.id, calls);
  }
  for (const calls of under.values()) calls.sort((a, b) => a.order - b.order);
  return under;
}

// Every call the given row made, at every depth, in the order they were made.
export function descendantsOf(row: ToolRow, under: ReadonlyMap<string, ToolRow[]>): ToolRow[] {
  return (under.get(row.id) ?? [])
    .flatMap((call) => [call, ...descendantsOf(call, under)])
    .sort((a, b) => a.order - b.order);
}

export function treeOf(row: ToolRow, under: ReadonlyMap<string, ToolRow[]>): CallNode {
  const calls = (under.get(row.id) ?? []).map((call) => treeOf(call, under));
  const [job] = calls;
  if (row.toolId === START_JOB && calls.length === 1 && job!.row.work?.kind === "job") {
    return { ...job!, start: row };
  }
  return { row, calls };
}

// Every call under the node as it shows, at every depth.
function allUnder(node: CallNode): CallNode[] {
  return node.calls.flatMap((call) => [call, ...allUnder(call)]);
}

const outcomes = (nodes: readonly CallNode[]) => nodes.map((node) => outcomeOf(node.row));

// How many calls sit under the node at every depth, and what became of them.
export function tallyOf(node: CallNode) {
  return { calls: allUnder(node).length, outcomes: outcomes(allUnder(node)) };
}

// Where the agent's own calls of a run stand, with the calls under them, each as it shows.
export function runStanding(calls: readonly ToolRow[], under: readonly ToolRow[]) {
  const below = callsUnder(under);
  const nodes = calls.map((call) => treeOf(call, below));
  return {
    standing: standingOf(outcomes(nodes), outcomes(nodes.flatMap(allUnder))),
    outcomes: outcomes(nodes),
  };
}

const holdsWaiting = (node: CallNode) => outcomes(allUnder(node)).includes("waiting");

// The last call under the node that is running and made none of its own.
export function runningNow(node: CallNode) {
  return allUnder(node).findLast(
    (call) => outcomeOf(call.row) === "running" && call.calls.length === 0,
  );
}

// Whether the node stands as its own row among its siblings: a call that made calls, or a job.
const standsAlone = (node: CallNode) =>
  node.calls.length > 0 || !!node.start || node.row.work?.kind === "job";

export type CallItem =
  | { kind: "call"; node: CallNode }
  | {
      kind: "tool";
      key: string;
      nodes: CallNode[];
      standing: Standing;
      outcomes: CallOutcome[];
    };

// The calls grouped by tool, in the order each tool was first called; a tool called once, and a
// call that stands alone, are rows of their own.
export function byTool(parent: CallNode): CallItem[] {
  const items: (CallItem | { kind: "group"; key: string; nodes: CallNode[] })[] = [];
  const groups = new Map<string, CallNode[]>();
  for (const node of parent.calls) {
    if (standsAlone(node)) {
      items.push({ kind: "call", node });
      continue;
    }
    const group = groups.get(node.row.toolId);
    if (group) {
      group.push(node);
      continue;
    }
    const nodes = [node];
    groups.set(node.row.toolId, nodes);
    items.push({ kind: "group", key: toolsKey(nodeId(parent), node.row.toolId), nodes });
  }
  return items.map((item): CallItem => {
    if (item.kind !== "group") return item;
    if (item.nodes.length === 1) return { kind: "call", node: item.nodes[0]! };
    const states = outcomes(item.nodes);
    return {
      kind: "tool",
      key: item.key,
      nodes: item.nodes,
      standing: standingOf(states),
      outcomes: states,
    };
  });
}

// What is held open so that each call waiting for approval under the node shows: the lines that
// lead to it, their calls, and the group of each by tool.
export function openForWaiting(node: CallNode): Set<string> {
  const keys = new Set<string>();
  const walk = (at: CallNode) => {
    if (!holdsWaiting(at)) return;
    keys.add(nodeLineKey(at));
    keys.add(callsKey(nodeId(at)));
    for (const item of byTool(at)) {
      if (item.kind === "call") walk(item.node);
      else if (item.standing === "waiting") keys.add(item.key);
    }
  };
  walk(node);
  return keys;
}

// What is opened to show the call with the id under the node: the line of each call above it, their
// calls, and the group by tool that holds each; none where it is not under the node.
function openTo(node: CallNode, id: string): string[] | null {
  if (node.row.id === id || node.start?.id === id) return [nodeLineKey(node)];
  for (const item of byTool(node)) {
    for (const child of item.kind === "tool" ? item.nodes : [item.node]) {
      const below = openTo(child, id);
      if (!below) continue;
      return [
        nodeLineKey(node),
        callsKey(nodeId(node)),
        ...(item.kind === "tool" ? [item.key] : []),
        ...below,
      ];
    }
  }
  return null;
}

// What is opened to show the call with the id among the rows, where another call made it: the run
// of calls that holds the agent's own call above it, and what leads from that call to it.
export function opensFor(rows: readonly ShownRow[], id: string): string[] {
  const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
  const byId = new Map(tools.map((row) => [row.id, row]));
  let root = byId.get(id);
  const seen = new Set<string>();
  while (root?.parent && byId.has(root.parent.id) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.parent.id);
  }
  if (!root || root.id === id) return [];
  const node = treeOf(root, callsUnder(tools));
  return [root.id, ...(openTo(node, id) ?? [])];
}
