// What a reader's tray shows of a thread: what runs or waits in it, the jobs, timers, schedules and
// webhooks set in it and the subagents its agent started, each with the row that holds its card,
// what the reader may do with it, and whether it asks for their attention; what ended leaves once
// they have seen its kind.

import type { Subagents } from "@/server/subagents/subagents.ts";
import { influenceIn } from "@/server/calls/influence.ts";
import type { Tools } from "@/server/tools/registry.ts";

import type { Reader as AccessReader } from "@/server/access/access.ts";
import type { WaitingCall } from "@/server/calls/calls.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Tasks } from "@/server/tasks/tasks.ts";
import { type ActivityList, type TrayKind, trayKindOf } from "@/shared/jobs.ts";
import { attentionOf, liveFor, subagentStatus, underway } from "./tray.ts";
import type { ToolRow as TranscriptToolRow, TranscriptRow } from "@/shared/transcript.ts";

import type { ThreadStore } from "@/server/threads/types.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";

import type { Needs } from "./needs.ts";
import type { Reads } from "./reads.ts";

export interface ActivityOptions {
  threads: Pick<ThreadStore, "findAll">;
  transcripts: Pick<Transcripts, "of">;
  tools: Pick<Tools, "namesIn" | "present" | "callStatesFor">;
  needs: Pick<Needs, "of">;
  reads: Pick<Reads, "activitySeen" | "markActivity">;
  subagents?: Pick<Subagents, "ofParents">;
  tasks?: Pick<Tasks, "listFor">;
  now?: () => Date;
}

export type Activity = ReturnType<typeof createActivity>;

// The tool rows among the rows.
function toolRowsOf(rows: readonly TranscriptRow[]) {
  return rows.filter((row): row is TranscriptToolRow => row.kind === "tool");
}

export function createActivity(options: ActivityOptions) {
  const { threads, transcripts, tools, reads, subagents, tasks } = options;
  const needs = options.needs;
  const waitingOn = options.needs;
  const now = options.now ?? (() => new Date());

  // What runs or waits in the thread, and the timers, schedules and webhooks set in it, each with
  // the row that holds its card; what the reader may do with them is theirs to do from here.
  async function activityOf(
    reader: AccessReader & { principal: Principal },
  ): Promise<ActivityList> {
    const { thread, principal, space } = reader;
    const names = tools.namesIn(space);
    const items: ActivityList["items"] = [];
    const at = now();
    const seen = await reads.activitySeen(principal.userId, thread.id);
    const add = (item: ActivityList["items"][number]) => {
      const seenAt = seen.get(trayKindOf(item.work));
      if (!liveFor(item.work, seenAt)) return;
      const attention = attentionOf(item.work, at);
      items.push({ ...item, ...(attention && { attention }) });
    };
    const { rows } = (await transcripts.of(thread.id)).transcript();
    const present = await tools.present(reader, toolRowsOf(rows));
    // The space's tools and the reader as they reach this thread tree, read once for its calls
    // and its subagents'.
    const states = tools.callStatesFor(reader);
    const waiting = new Map(
      (
        (await needs.of({ userId: principal.userId, states }, [thread.id])).get(thread.id) ?? []
      ).map((one) => [one.call.id, one]),
    );
    for (const [index, row] of rows.entries()) {
      if (row.kind !== "tool") continue;
      const waits = waiting.get(row.id);
      // A call waiting for a decision, whoever may make it; the others see it wait.
      if (waits?.waitsFor === "decision") {
        add({
          rowId: row.id,
          title: (await names(row)).title,
          work: {
            kind: "decision",
            status: "waiting",
            canDecide: waits.canAct,
            startedAt: row.requestedAt,
            canCancel: false,
          },
        });
      }
      const work = present(row).work;
      if (work?.kind === "job") {
        // Whose words the agent had read when it asked for the call.
        const steering = influenceIn(rows.slice(0, index));
        const by = [...new Set(steering.map((one) => one.name))].join(", ");
        add({
          rowId: row.id,
          title: (await names(row)).title,
          work: { ...work, ...(work.status === "waiting" && { canDecide: !!waits?.canAct }) },
          ...(by && { by }),
        });
      } else if (work && underway(work)) {
        add({
          rowId: row.id,
          title: work.schedule?.name ?? work.webhook?.name ?? (await names(row)).title,
          work,
        });
      }
    }
    const given = (await tasks?.listFor(principal, thread.id, false, reader))?.tasks ?? [];
    const started = ((await subagents?.ofParents([thread.id])) ?? []).filter(
      ({ summary }) => summary.state !== "archived",
    );
    // Their threads, and what waits on those that need someone, read once for them all.
    const childThreads = new Map(
      (await threads.findAll(started.map(({ record }) => record.threadId))).map((one) => [
        one.id,
        one,
      ]),
    );
    const needing = started
      .filter(({ summary }) => summary.needs)
      .map(({ record }) => record.threadId);
    const waitingIn =
      needing.length > 0
        ? await waitingOn.of({ userId: principal.userId, states }, needing)
        : new Map<string, WaitingCall[]>();
    // A subagent's thread is read and posted in as its starter's is.
    const mayPost = reader.can("post");
    for (const { record, summary } of started) {
      const child = childThreads.get(record.threadId);
      if (!child) continue;
      const { state, needs } = summary;
      const its = given.filter(
        (task) => task.assignee?.kind === "subagent" && task.assignee.threadId === record.threadId,
      );
      // What it waits on asks only the readers who may decide or answer it.
      const childRun = needs ? waitingIn.get(child.id) : null;
      const waiting = childRun?.find((one) => !one.call.background) ?? null;
      const waitingRow = waiting?.call.id;
      add({
        rowId: record.threadId,
        title: record.name,
        work: {
          kind: "subagent",
          status: subagentStatus(state, needs),
          ...(needs && { canDecide: !!waiting?.canAct }),
          subagent: {
            threadId: record.threadId,
            state,
            ...(needs && { needs }),
            ...(its.length > 0 && {
              tasks: {
                done: its.filter((task) => task.status === "done").length,
                total: its.length,
              },
            }),
            ...(waitingRow && { waitingRow }),
          },
          startedAt: record.createdAt.toISOString(),
          ...(state === "stopped" && {
            endedAt: child.updatedAt.toISOString(),
          }),
          canCancel: state === "working" && mayPost,
        },
      });
    }
    return { items };
  }

  return {
    // The live activity of the thread, as the reader sees it.
    of: activityOf,

    // Notes that the reader has seen a kind of it, so what ended leaves their tray.
    async seen(reader: AccessReader & { principal: Principal }, kind: TrayKind) {
      await reads.markActivity(reader.principal.userId, reader.thread.id, kind);
      return activityOf(reader);
    },
  };
}
