// A thread's history worked out from its branches: where a new branch starts from a row, which
// rows it leaves out of the current branch, what a reader may do from each row, which rows are
// versions of one another and which branch shows each version, and the branch map.

import type { RowAction, RowVersions } from "@/shared/threads/rows.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import { FORMER_TOOL_IDS } from "@/shared/tools.ts";
import type { TranscriptFold, TranscriptRow } from "@/shared/transcript.ts";

import type { Branch } from "./service.ts";

// What a branch takes of another: its events up to `untilSeq`, all of them when null.
export interface Source {
  branchId: string;
  untilSeq: number | null;
}

// The seq a branch that writes the row at `index` again starts after: everything before the row.
export function cutBefore(rows: readonly TranscriptRow[], index: number) {
  return rows[index]!.seq - 1;
}

// The seq a branch that ends at the row at `index` starts after: every event that made or changed
// that row or any before it.
export function cutThrough(fold: Pick<TranscriptFold, "touchedAt">, index: number) {
  let cut = 0;
  for (let at = 0; at <= index; at++) cut = Math.max(cut, fold.touchedAt(at));
  return cut;
}

// The rows of `current` that a branch made of `kept` would no longer hold.
export function dropped(current: readonly TranscriptRow[], kept: readonly TranscriptRow[]) {
  const ids = new Set(kept.map((row) => row.id));
  return current.filter((row) => !ids.has(row.id));
}

// For each row of `viewed`, whether a branch ending at it would leave out of the current branch a
// message of someone other than the person: the index past which one of theirs is no longer kept.
export function othersPast(
  current: readonly TranscriptRow[],
  viewed: readonly TranscriptRow[],
  userId: string,
) {
  const at = new Map(viewed.map((row, index) => [row.id, index]));
  let past = -1;
  for (const row of current) {
    if (row.kind !== "human" || row.author.userId === userId) continue;
    past = Math.max(past, at.get(row.id) ?? Infinity);
  }
  return past;
}

// Whether the call changed something: it ran, and its tool does not say it only reads.
export function changedSomething(row: TranscriptRow, definitions: readonly ToolDefinition[]) {
  if (row.kind !== "tool" || row.state !== "ran") return false;
  const name = FORMER_TOOL_IDS[row.toolId] ?? row.toolId;
  const tool = definitions.find((definition) => definition.name === name);
  return tool?.annotations?.readOnlyHint !== true;
}

// What the reader may do from each row of a branch, with what is known of them and of the branch.
export interface Abilities {
  userId: string;
  // The branch is the thread's current one.
  current: boolean;
  // They may post in the thread.
  post: boolean;
  // They may write past other people's messages, leaving them out of the current branch.
  rewrite: boolean;
  // They may start threads in its space.
  fork: boolean;
  // The index past which a branch from a row leaves out another person's message.
  othersPast: number;
}

export function rowActions(
  rows: readonly TranscriptRow[],
  index: number,
  can: Abilities,
): RowAction[] {
  const row = rows[index]!;
  const message = row.kind === "human" || (row.kind === "agent" && row.status !== "streaming");
  if (!message) return [];
  const past = can.rewrite || can.othersPast <= index;
  const actions: RowAction[] = [];
  if (can.current && can.post && past) {
    if (row.kind === "agent") actions.push("retry");
    if (row.kind === "human" && row.author.userId === can.userId && !row.command) {
      actions.push("edit");
    }
  }
  // On the current branch a restore leaves out what follows, so it needs a message after it.
  const followed = rows
    .slice(index + 1)
    .some((after) => after.kind === "human" || after.kind === "agent");
  if (can.post && past && (!can.current || followed)) actions.push("restore");
  if (can.fork) actions.push("fork");
  if (can.post) actions.push("aside");
  return actions;
}

// One version of a row: the branch whose own event made it, that event's seq, and its id.
interface Version {
  owner: string;
  seq: number;
  rowId: string;
}

function holds(sources: readonly Source[], version: Version) {
  return sources.some(
    (source) =>
      source.branchId === version.owner &&
      (source.untilSeq === null || version.seq <= source.untilSeq),
  );
}

// The versions of the rows written again, as `viewed` shows them: for each such row of it, which
// version it is and the branch that shows each version, the current one where it holds that
// version, else the newest that does. Each branch that wrote a row again holds its own version from
// its first row; the first version is the row the earliest of them wrote again, made in `origin`.
// One restored from a row goes on in place of the message after with the line saying so, which is
// its version from the moment it is made. Also, by row, the first row of the versions each belongs
// to.
export function versionsOf(input: {
  viewed: string;
  current: string;
  branches: readonly Branch[];
  rows: readonly TranscriptRow[];
  sourcesOf: (branchId: string) => readonly Source[];
  // The id and seq of the first row of the branch's own, if it has one yet.
  firstOf: (branch: Branch) => { id: string; seq: number } | null;
  // The row of the versions as the branch holds it: its seq and the branch whose event made it.
  originOf: (branchId: string, rowId: string) => { owner: string; seq: number } | null;
}) {
  const { viewed, current, branches, rows, sourcesOf, firstOf, originOf } = input;
  const versions = new Map<string, RowVersions>();
  const groupOf = new Map<string, string>();
  const groups = new Map<string, Branch[]>();
  for (const branch of branches) {
    if (!branch.groupRowId) continue;
    groups.set(branch.groupRowId, [...(groups.get(branch.groupRowId) ?? []), branch]);
  }
  const newestFirst = branches.toSorted(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  const viewedSources = sourcesOf(viewed);
  const currentSources = sourcesOf(current);
  for (const [groupRowId, members] of groups) {
    const first = members[0]!;
    const origin = first.parentBranchId ? originOf(first.parentBranchId, groupRowId) : null;
    const all: (Version | null)[] = [
      origin && { ...origin, rowId: groupRowId },
      ...members.map((member) => {
        const own = firstOf(member);
        return own && { owner: member.id, seq: own.seq, rowId: own.id };
      }),
    ];
    const known = all.filter((version): version is Version => version !== null);
    if (known.length < 2) continue;
    for (const version of known) groupOf.set(version.rowId, groupRowId);
    const shown = new Set(rows.map((row) => row.id));
    const at = known.findIndex(
      (version) => holds(viewedSources, version) && shown.has(version.rowId),
    );
    if (at === -1) continue;
    const shownIn = known.map((version) =>
      holds(currentSources, version)
        ? current
        : (newestFirst.find((branch) => holds(sourcesOf(branch.id), version))?.id ?? version.owner),
    );
    versions.set(known[at]!.rowId, { at, branches: shownIn });
  }
  return { versions, groupOf };
}
