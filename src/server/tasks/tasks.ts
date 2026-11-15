// Tasks: a thread's list of what its work is made of, kept by its agent with the tasks tools and by
// the people who may post in it, each task with where it stands and whom it is for. A subagent
// started to share its starter's list reads and changes that one; any other keeps its own. A person
// who changes a task given to an agent tells that agent, as the person whose words it carries. An
// agent may also watch tasks, to be told once when one is done or changes by someone else.

import { ulid } from "ulid";
import * as z from "zod";

import type { Signals } from "@/server/sync/signals.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Reader, ThreadAccess } from "@/server/access/access.ts";
import type { Thread, ThreadStore } from "@/server/threads/types.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import type { ThreadLog } from "@/server/threads/log.ts";
import { DEFAULT_AGENT_NAME } from "@/shared/orgs.ts";
import {
  ADD_LIMIT,
  type Task,
  type TaskActor,
  type TaskAssignee,
  type TaskCandidate,
  type TaskChangeInput,
  type TaskList,
  type TaskStatus,
  TASK_LIMIT,
  TASKS_TOOLSET,
  taskStatusSchema,
  titleSchema,
} from "@/shared/tasks.ts";
import type { Change, NoticeActor, Influencer } from "@/shared/threads/events.ts";

import type { Notice } from "@/server/queue/notices.ts";
import { silentChange } from "@/server/queue/notices.ts";
import type { Queue } from "@/server/queue/queue.ts";
import { WATCH_LIMIT, type Watch, type WatchStore } from "@/server/subagents/watches.ts";
import { influenceIn } from "@/server/calls/influence.ts";
import type { Subagents } from "@/server/subagents/subagents.ts";
import type { Toolset, ToolSpec } from "@/server/tools/registry.ts";
import { filterAsync } from "@/server/kernel/async.ts";

export interface TaskRecord {
  id: string;
  threadId: string;
  title: string;
  status: TaskStatus;
  assignee: TaskAssignee;
  position: number;
  createdBy: TaskActor;
  updatedBy: TaskActor;
  updatedAt: Date;
  // When it was archived; an archived task is off the list and kept as history.
  archivedAt: Date | null;
}

export interface TaskStore {
  // The thread whose list the thread works on in place of its own, if any.
  sharedWith(threadId: string): Promise<string | null>;
  // Has the thread work on the owner's list from now on.
  share(threadId: string, ownerThreadId: string): Promise<void>;
  // The thread's tasks in order: the ones on the list, or with archived set the ones archived.
  inThread(threadId: string, archived?: boolean): Promise<TaskRecord[]>;
  find(id: string): Promise<TaskRecord | null>;
  // Adds the thread's tasks after its last, in order.
  add(rows: Omit<TaskRecord, "position" | "updatedAt" | "archivedAt">[]): Promise<TaskRecord[]>;
  update(
    id: string,
    fields: Partial<
      Pick<TaskRecord, "title" | "status" | "assignee" | "updatedBy" | "updatedAt" | "archivedAt">
    >,
  ): Promise<TaskRecord | undefined>;
  remove(ids: string[]): Promise<void>;
  userName(userId: string): Promise<string | null>;
}

// What the agent is told about them.
export const TASKS_GUIDANCE =
  "Keep a task list for work in several steps: add the steps with thread.add_tasks, set each to doing when you start it and done when it is finished. People can check off and edit tasks too, and a change to a task given to you arrives as a notification. Tasks can be given to you, a subagent or a person who has written in the thread; a subagent sharing your list sees its own tasks unless it asks for all; a subagent is an assignee once started, so plan tasks first, then start subagents with their task ids. To wait on someone else's task, watch it with thread.watch_tasks and end your turn: you are told once when it is done or changed, so do not list the tasks again to check. When a block of work is complete, archive its done tasks with thread.archive_tasks so the list shows only current work. Keep titles short.";

export interface TasksOptions {
  tasks: TaskStore;
  threads: Pick<ThreadStore, "find">;
  transcripts: Pick<Transcripts, "of">;
  access: Pick<ThreadAccess, "require" | "can">;
  // The org a space belongs to, for who may post.
  orgOf: (spaceId: string) => Promise<string | null>;
  subagents: Pick<Subagents, "find" | "mayStart" | "ofParents">;
  log: ThreadLog;
  signals: Signals;
  // What the agent of the space's threads goes by.
  agentNameIn?: (spaceId: string) => Promise<string>;
  queue: Pick<Queue, "enqueue">;
  // Agents waiting on tasks, as on subagents.
  watches: Pick<WatchStore, "add" | "on" | "count" | "end">;
  now?: () => Date;
}

export type Tasks = ReturnType<typeof createTasks>;

// A call the tool refuses, with what the model is told.
class ToolRefusal extends Error {}

async function refusing(work: () => unknown) {
  try {
    return { ok: true as const, value: await work() };
  } catch (err) {
    if (err instanceof ToolRefusal) return { ok: false as const, error: err.message };
    throw err;
  }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const STATUS_WORDS: Record<TaskStatus, string> = {
  todo: "back to to do",
  doing: "as doing",
  done: "as done",
};

export function createTasks(options: TasksOptions) {
  const { tasks, threads, subagents, signals } = options;
  const now = options.now ?? (() => new Date());
  const agentNameIn = options.agentNameIn ?? (() => DEFAULT_AGENT_NAME);
  const { queue, watches } = options;

  // Tells the thread's agent of a change to a task list: as the person who made it, or as the list.
  async function notify(threadId: string, notice: Notice) {
    const origin =
      notice.actor?.kind === "person"
        ? undefined
        : { kind: "task" as const, id: notice.source.threadId };
    await queue.enqueue(threadId, { kind: "notice", notice }, { ...(origin && { origin }) });
  }

  // The thread whose list the thread works on: its starter's for a subagent started to share it.
  async function ownerOf(threadId: string) {
    return (await tasks.sharedWith(threadId)) ?? threadId;
  }

  // The owner's subagents that are not retired.
  async function liveSubagents(ownerId: string) {
    return (await subagents.ofParents([ownerId]))
      .filter(({ record }) => !record.archivedAt)
      .map(({ record }) => ({ threadId: record.threadId, name: record.name }));
  }

  function shown(record: TaskRecord): Task {
    const { threadId: _thread, position, updatedAt, archivedAt: _archived, ...rest } = record;
    return { ...rest, order: position, updatedAt: updatedAt.toISOString() };
  }

  function changed(ownerId: string) {
    signals.changed({ threadId: ownerId, tasks: true });
  }

  async function listOf(
    ownerId: string,
    canEdit: boolean,
    shared = false,
    archived = false,
  ): Promise<TaskList> {
    return {
      ...(shared && { shared }),
      tasks: (await tasks.inThread(ownerId, archived)).map(shown),
      canEdit: canEdit && !archived,
      subagents: await liveSubagents(ownerId),
      assignees: archived ? [] : await candidatesOf(ownerId),
    };
  }

  // Who the agent working in the thread is, by name.
  // The agent or person that did something to the tasks.
  type ByWho = { name: string; threadId?: string; userId?: string };

  async function actorOf(by: ByWho): Promise<NoticeActor | undefined> {
    if (by.userId) return { kind: "person", userId: by.userId, name: by.name };
    if (!by.threadId) return undefined;
    return {
      kind: "agent",
      threadId: by.threadId,
      name: by.name,
      main: !(await subagents.find(by.threadId)),
    };
  }

  async function agentActor(threadId: string, spaceId: string): Promise<TaskActor> {
    const subagent = await subagents.find(threadId);
    return { kind: "agent", name: subagent?.name ?? (await agentNameIn(spaceId)) };
  }

  // The people who have written in the list owner's thread, by name, with whether they may post.
  async function writersOf(ownerId: string) {
    const thread = await threads.find(ownerId);
    const orgId = thread && (await options.orgOf(thread.spaceId));
    const rows = (await options.transcripts.of(ownerId)).transcript().rows;
    const seen = new Map<string, { userId: string; name: string; canPost: boolean }>();
    for (const row of rows) {
      if (row.kind !== "human" || seen.has(row.author.userId)) continue;
      const { userId, name } = row.author;
      seen.set(userId, {
        userId,
        name: name ?? "Someone",
        canPost:
          !!thread && !!orgId && (await options.access.can({ userId, orgId }, thread, "post")),
      });
    }
    return [...seen.values()];
  }

  // Whom a task of the list may be given to: the agent, the live subagents and the people who have
  // written in the thread and may post in it.
  async function candidatesOf(ownerId: string): Promise<TaskCandidate[]> {
    const thread = await threads.find(ownerId);
    return [
      { kind: "agent", name: thread ? await agentNameIn(thread.spaceId) : DEFAULT_AGENT_NAME },
      ...(await liveSubagents(ownerId)).map((one) => ({ kind: "subagent" as const, ...one })),
      ...(await writersOf(ownerId))
        .filter((one) => one.canPost)
        .map(({ userId, name }) => ({ kind: "person" as const, userId, name })),
    ];
  }

  // The assignee a name the agent gave stands for: agent, a live subagent of the list's owner, or a
  // person who wrote in the thread and may post in it, by name or id.
  async function resolve(ownerId: string, label: string): Promise<TaskAssignee> {
    if (sameName(label, "agent")) return { kind: "agent" };
    const live = await liveSubagents(ownerId);
    const found = live.find((one) => sameName(one.name, label));
    if (found) return { kind: "subagent", ...found };
    const writers = await writersOf(ownerId);
    const people = writers.filter((one) => one.userId === label.trim());
    const named = people.length > 0 ? people : writers.filter((one) => sameName(one.name, label));
    if (named.length > 1) {
      throw new ToolRefusal(
        `${label} names more than one person: ${named.map((one) => `${one.name} (${one.userId})`).join(", ")}. Give an id.`,
      );
    }
    const [person] = named;
    if (person) {
      if (!person.canPost) throw new ToolRefusal(`${person.name} cannot post in this thread.`);
      return { kind: "person", userId: person.userId, name: person.name };
    }
    const names = [
      "agent",
      ...live.map((one) => one.name),
      ...writers.filter((one) => one.canPost).map((one) => `${one.name} (${one.userId})`),
    ].join(", ");
    throw new ToolRefusal(
      `${label} is not an assignee. Assignees: ${names}. A subagent becomes an assignee once started, by its name; give it tasks at start with subagents.start tasks.`,
    );
  }

  async function mine(id: string, ownerId: string) {
    const record = await tasks.find(id);
    if (!record || record.threadId !== ownerId || record.archivedAt) {
      throw new ToolRefusal(`No task ${id}.`);
    }
    return record;
  }

  function shownBrief(record: TaskRecord) {
    const { id, title, status, assignee } = shown(record);
    return {
      id,
      title,
      status,
      ...(assignee && {
        assignee: assignee.kind === "agent" ? "agent" : assignee.name,
        assigneeKind: assignee.kind,
      }),
    };
  }

  const assigneeField = z.string().min(1).meta({
    title: "Assignee",
    description: "agent, a subagent's label, or a person who wrote here, by name or id",
  });

  // The tasks of the list the thread may see: a subagent sharing its starter's list sees its own
  // unless all is set.
  async function visible(ownerId: string, threadId: string, all: boolean, archived = false) {
    const every = await tasks.inThread(ownerId, archived);
    if (ownerId === threadId || all) return { shown: every, others: 0 };
    const shown = every.filter(
      (task) => task.assignee?.kind === "subagent" && task.assignee.threadId === threadId,
    );
    return { shown, others: every.length - shown.length };
  }

  const list: ToolSpec<{ all?: boolean; archived?: boolean }> = {
    name: "tasks.list",
    modelName: "thread.list_tasks",
    title: "List",
    annotations: { readOnlyHint: true },
    description:
      "The task list: id, title, status, assignee, in order. A subagent sharing its starter's list sees its own tasks unless all is true. Archived tasks are left out unless archived is true.",
    input: z.object({
      all: z.boolean().optional().meta({ title: "All", description: "Every task, not just yours" }),
      archived: z
        .boolean()
        .optional()
        .meta({ title: "Archived", description: "The archived tasks, not the list" }),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(async () => {
        const ownerId = await ownerOf(ctx.threadId);
        const { shown: found, others } = await visible(
          ownerId,
          ctx.threadId,
          !!input.all,
          !!input.archived,
        );
        if (others === 0) return { tasks: found.map(shownBrief) };
        return {
          tasks: found.map(shownBrief),
          ...(others > 0 && {
            note: `${others} more task${others === 1 ? "" : "s"} on the list; all: true to see them`,
          }),
        };
      });
    },
  };

  const add: ToolSpec<{ tasks: { title: string; assignee?: string }[] }> = {
    name: "tasks.add",
    modelName: "thread.add_tasks",
    title: "Add",
    annotations: { readOnlyHint: false },
    description: `Add tasks to the end of the list, up to ${ADD_LIMIT} at once. Every task is for someone; without an assignee it is yours.`,
    input: z.object({
      tasks: z
        .array(
          z.object({
            title: titleSchema.meta({ title: "Title" }),
            assignee: assigneeField.optional(),
          }),
        )
        .min(1)
        .max(ADD_LIMIT)
        .meta({ title: "Tasks" }),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(async () => {
        const ownerId = await ownerOf(ctx.threadId);
        if ((await tasks.inThread(ownerId)).length + input.tasks.length > TASK_LIMIT) {
          throw new ToolRefusal(`A list holds ${TASK_LIMIT} tasks. Remove some first.`);
        }
        const by = await agentActor(ctx.threadId, ctx.spaceId);
        // A task without an assignee is the creator's: a subagent sharing the list, else the agent.
        const sharing = await subagents.find(ctx.threadId);
        const own: TaskAssignee =
          sharing && ownerId !== ctx.threadId
            ? { kind: "subagent", threadId: ctx.threadId, name: sharing.name }
            : { kind: "agent" };
        const added = await tasks.add(
          await Promise.all(
            input.tasks.map(async (task) => ({
              id: ulid(),
              threadId: ownerId,
              title: task.title,
              status: "todo" as const,
              assignee: task.assignee ? await resolve(ownerId, task.assignee) : own,
              createdBy: by,
              updatedBy: by,
            })),
          ),
        );
        changed(ownerId);
        for (const record of added) await giveToSubagent(ownerId, record, by.name, ctx.threadId);
        await announceAdded(ownerId, { name: by.name, threadId: ctx.threadId }, added);
        return { tasks: added.map(shownBrief) };
      });
    },
  };

  const update: ToolSpec<{
    id: string;
    status?: TaskStatus;
    title?: string;
    assignee?: string;
  }> = {
    name: "tasks.update",
    modelName: "thread.update_task",
    title: "Update",
    annotations: { readOnlyHint: false },
    description: "Change a task's status, title or assignee.",
    input: z.object({
      id: z.string().min(1).meta({ title: "Id" }),
      status: taskStatusSchema.optional().meta({ title: "Status" }),
      title: titleSchema.optional().meta({ title: "Title" }),
      assignee: assigneeField.optional(),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(async () => {
        const ownerId = await ownerOf(ctx.threadId);
        const record = await mine(input.id, ownerId);
        const by = await agentActor(ctx.threadId, ctx.spaceId);
        const next = await tasks.update(record.id, {
          ...(input.status && { status: input.status }),
          ...(input.title && { title: input.title }),
          ...(input.assignee !== undefined && { assignee: await resolve(ownerId, input.assignee) }),
          updatedBy: by,
          updatedAt: now(),
        });
        changed(ownerId);
        if (next && input.assignee && !sameAssignee(record.assignee, next.assignee)) {
          await giveToSubagent(ownerId, next, by.name, ctx.threadId);
        }
        await announce(
          ownerId,
          { name: by.name, threadId: ctx.threadId, people: await peopleOf(ctx.threadId) },
          record,
          next ?? record,
          {
            ...(input.status && { status: input.status }),
            ...(input.title && { title: input.title }),
            ...(input.assignee !== undefined && { assignee: { kind: "agent" as const } }),
          },
        );
        return shownBrief(next ?? record);
      });
    },
  };

  const remove: ToolSpec<{ ids: string[] }> = {
    name: "tasks.remove",
    modelName: "thread.remove_task",
    title: "Remove",
    annotations: { readOnlyHint: false },
    description: "Remove tasks from the list.",
    input: z.object({ ids: z.array(z.string().min(1)).min(1).meta({ title: "Ids" }) }),
    risk: () => "normal",
    run({ ids }, ctx) {
      return refusing(async () => {
        const ownerId = await ownerOf(ctx.threadId);
        const records = await Promise.all(ids.map(async (id) => mine(id, ownerId)));
        await tasks.remove(ids);
        changed(ownerId);
        const by = await agentActor(ctx.threadId, ctx.spaceId);
        for (const record of records) {
          await announce(
            ownerId,
            { name: by.name, threadId: ctx.threadId, people: await peopleOf(ctx.threadId) },
            record,
            null,
            {},
          );
        }
        return { removed: ids };
      });
    },
  };

  const archive: ToolSpec<{ ids?: string[] }> = {
    name: "tasks.archive",
    modelName: "thread.archive_tasks",
    title: "Archive",
    annotations: { readOnlyHint: false },
    description:
      "Archive done tasks so the list shows only current work: the ones named, which must all be done, or every done task. A subagent sharing its starter's list archives its own. Returns the list that remains.",
    input: z.object({ ids: z.array(z.string().min(1)).min(1).optional().meta({ title: "Ids" }) }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(async () => {
        const ownerId = await ownerOf(ctx.threadId);
        const { shown: yours } = await visible(ownerId, ctx.threadId, false);
        let targets: TaskRecord[];
        if (input.ids) {
          targets = await Promise.all(input.ids.map(async (id) => mine(id, ownerId)));
          const foreign = targets.filter((record) => !yours.some((one) => one.id === record.id));
          if (foreign.length > 0) {
            throw new ToolRefusal(
              `Not given to you: ${foreign.map((record) => `${record.id} "${record.title}"`).join(", ")}.`,
            );
          }
          const open = targets.filter((record) => record.status !== "done");
          if (open.length > 0) {
            throw new ToolRefusal(
              `Not done: ${open.map((record) => `${record.id} "${record.title}"`).join(", ")}. Only done tasks are archived.`,
            );
          }
        } else {
          targets = yours.filter((record) => record.status === "done");
        }
        const by = await agentActor(ctx.threadId, ctx.spaceId);
        const archived = await archiveAll(ownerId, targets, by);
        await announceArchive(
          ownerId,
          { name: by.name, threadId: ctx.threadId, people: await peopleOf(ctx.threadId) },
          archived,
        );
        return {
          archived: archived.map((record) => record.id),
          tasks: (await visible(ownerId, ctx.threadId, false)).shown.map(shownBrief),
        };
      });
    },
  };

  const watch: ToolSpec<{ ids?: string[]; until?: "done" | "changed" }> = {
    name: "tasks.watch",
    modelName: "thread.watch_tasks",
    title: "Watch",
    annotations: { readOnlyHint: false },
    description:
      "Be told once when tasks are done (default) or when any changes, by a person or another agent. No ids: all open tasks. Then end your turn.",
    input: z.object({
      ids: z.array(z.string().min(1)).min(1).optional().meta({ title: "Ids" }),
      until: z.enum(["done", "changed"]).optional().meta({ title: "Until" }),
    }),
    risk: () => "normal",
    run(input, ctx) {
      return refusing(async () => {
        const ownerId = await ownerOf(ctx.threadId);
        const until = input.until ?? "done";
        const named = input.ids
          ? await Promise.all(input.ids.map(async (id) => mine(id, ownerId)))
          : null;
        const open = (named ?? (await tasks.inThread(ownerId))).filter(
          (record) => (named && until === "changed") || record.status !== "done",
        );
        if (open.length === 0) {
          return {
            watching: [],
            note: named
              ? "Those tasks are already done."
              : "No task is open, so there is nothing to wait on.",
          };
        }
        if ((await watches.count(ctx.threadId)) >= WATCH_LIMIT) {
          throw new ToolRefusal(`You can have ${WATCH_LIMIT} watches at once. Wait for one first.`);
        }
        await watches.add({
          id: ulid(),
          threadId: ctx.threadId,
          ownerId,
          kind: "tasks",
          until,
          callId: ctx.callId,
          subjects: open.map((record) => record.id),
        });
        return {
          watching: open.map(shownBrief),
          until,
          note: "You will be told once. End your turn rather than listing the tasks again.",
        };
      });
    },
  };

  // Archives the tasks, as the one who did it, and tells the page.
  async function archiveAll(ownerId: string, records: TaskRecord[], by: TaskActor) {
    const at = now();
    const archived = (
      await Promise.all(
        records.map(
          async (record) =>
            (await tasks.update(record.id, { archivedAt: at, updatedBy: by, updatedAt: at })) ?? [],
        ),
      )
    ).flat();
    if (archived.length > 0) changed(ownerId);
    return archived;
  }

  // Tells the agents watching archived tasks, in one notice, that someone archived them, and the
  // agent of the list and those the tasks were given to, without waking them. Whoever archived
  // them is not told.
  async function announceArchive(
    ownerId: string,
    by: ByWho & { people: Influencer[] },
    records: TaskRecord[],
  ) {
    if (records.length === 0) return;
    const titles = records.map((record) => `"${record.title}"`).join(", ");
    const text =
      records.length === 1
        ? `${by.name} archived task ${titles}.`
        : `${by.name} archived ${records.length} tasks: ${titles}.`;
    const what: Change = {
      subject: {
        kind: "task",
        name: records.length === 1 ? records[0]!.title : `${records.length} tasks`,
      },
      action: "archive",
    };
    const reached = new Set<string>();
    for (const watch of await watches.on(ownerId, "tasks")) {
      if (!records.some((record) => fires(watch, record, record))) continue;
      if (await watches.end(watch.id)) reached.add(watch.threadId);
    }
    for (const threadId of reached) {
      if (threadId === by.threadId || !(await threads.find(threadId))) continue;
      await notify(threadId, {
        kind: "task.changed",
        source: { threadId: ownerId, name: "Tasks", main: true },
        actor: await actorOf(by),
        change: what,
        text,
        influence: by.people,
      });
    }
    await tellQuietly(
      ownerId,
      by,
      records.flatMap((record) => [record.assignee]),
      reached,
      text,
      what,
    );
  }

  // Tells the list's agent and the agents tasks are given to, without waking them, what someone
  // did, unless they were told already or did it.
  async function tellQuietly(
    ownerId: string,
    by: ByWho,
    assignees: (TaskAssignee | null | undefined)[],
    told: ReadonlySet<string>,
    text: string,
    change?: Change,
  ) {
    const quiet = new Set([ownerId]);
    for (const assignee of assignees) {
      if (assignee?.kind === "subagent") quiet.add(assignee.threadId);
    }
    for (const threadId of quiet) {
      if (told.has(threadId) || threadId === by.threadId || !(await threads.find(threadId)))
        continue;
      await notify(
        threadId,
        silentChange(threadId, by.name, text, "tasks", await actorOf(by), change),
      );
    }
  }

  // Tells the list's agent, without waking it, that someone added tasks.
  async function announceAdded(ownerId: string, by: ByWho, records: TaskRecord[]) {
    if (records.length === 0) return;
    const titles = records.map((record) => `"${record.title}"`).join(", ");
    const text =
      records.length === 1
        ? `${by.name} added task ${titles}.`
        : `${by.name} added ${records.length} tasks: ${titles}.`;
    await tellQuietly(ownerId, by, [], new Set(), text, {
      subject: {
        kind: "task",
        name: records.length === 1 ? records[0]!.title : `${records.length} tasks`,
      },
      action: "add",
    });
  }

  // The people whose words steered the thread's agent.
  async function peopleOf(threadId: string): Promise<Influencer[]> {
    return influenceIn((await options.transcripts.of(threadId)).transcript().rows);
  }

  function sameAssignee(a: TaskAssignee, b: TaskAssignee) {
    return a?.kind === "subagent" && b?.kind === "subagent" && a.threadId === b.threadId;
  }

  // A task given to a subagent puts the list in its hands and tells it, so an idle one wakes.
  async function giveToSubagent(
    ownerId: string,
    record: TaskRecord,
    who: string,
    byThread?: string,
  ) {
    const { assignee } = record;
    if (assignee?.kind !== "subagent") return;
    await tasks.share(assignee.threadId, ownerId);
    if (assignee.threadId === byThread || !(await threads.find(assignee.threadId))) return;
    await notify(assignee.threadId, {
      kind: "task.changed",
      source: { threadId: ownerId, name: "Tasks", main: true },
      actor: {
        kind: "agent",
        threadId: byThread ?? ownerId,
        name: who,
        main: !(await subagents.find(byThread ?? ownerId)),
      },
      change: {
        subject: { kind: "task", name: record.title },
        action: "assign",
        to: assignee.name,
      },
      text: `${who} gave you task "${record.title}". The task list is now shared with you: read it with thread.list_tasks and mark the task as doing and done.`,
      influence: byThread ? await peopleOf(byThread) : [],
    });
  }

  // What was done to a task, as the agent it is for, or one watching, is told.
  function noticeText(
    who: string,
    before: TaskRecord,
    after: TaskRecord | null,
    change: TaskChangeInput,
  ) {
    const title = `"${after?.title ?? before.title}"`;
    if (!after) return `${who} removed task ${title}.`;
    const parts: string[] = [];
    if (change.status && change.status !== before.status) {
      parts.push(`${who} marked task ${title} ${STATUS_WORDS[change.status]}.`);
    }
    if (change.title && change.title !== before.title) {
      parts.push(`${who} renamed task "${before.title}" to ${title}.`);
    }
    if (change.assignee !== undefined) parts.push(`${who} changed who task ${title} is for.`);
    return parts.join(" ");
  }

  // What was done to a task, in parts, for its card: the first of what changed.
  function changeOf(
    before: TaskRecord,
    after: TaskRecord | null,
    change: TaskChangeInput,
  ): Change | undefined {
    const name = after?.title ?? before.title;
    if (!after) return { subject: { kind: "task", name }, action: "remove" };
    if (change.status && change.status !== before.status) {
      return {
        subject: { kind: "task", name },
        action: "status",
        from: before.status,
        to: change.status,
      };
    }
    if (change.title && change.title !== before.title) {
      return {
        subject: { kind: "task", name },
        action: "rename",
        from: before.title,
        to: name,
      };
    }
    if (change.assignee !== undefined) {
      return {
        subject: { kind: "task", name },
        action: "assign",
        to: after.assignee?.kind === "agent" ? DEFAULT_AGENT_NAME : after.assignee?.name,
      };
    }
    return undefined;
  }

  // Whether the change is what the watch waits for.
  function fires(watch: Watch, before: TaskRecord, after: TaskRecord | null) {
    if (!watch.subjects.includes(before.id)) return false;
    if (watch.until === "changed") return true;
    return !after || (after.status === "done" && before.status !== "done");
  }

  // Tells the agents a task was given to, before or after the change, that someone changed it, and
  // the agents watching it, which hear once and whose watch ends. Whoever changed it is not told.
  async function announce(
    ownerId: string,
    by: ByWho & { people: Influencer[] },
    before: TaskRecord,
    after: TaskRecord | null,
    change: TaskChangeInput,
  ) {
    const text = noticeText(by.name, before, after, change);
    if (!text) return;
    const what = changeOf(before, after, change);
    const reached = new Set<string>();
    // Only a person's change is told to the agent a task is given to.
    if (!by.threadId) {
      for (const assignee of [before.assignee, after?.assignee]) {
        if (assignee?.kind === "agent") reached.add(ownerId);
        if (assignee?.kind === "subagent") reached.add(assignee.threadId);
      }
    }
    for (const watch of await watches.on(ownerId, "tasks")) {
      if (!fires(watch, before, after) || watch.threadId === by.threadId) continue;
      if (await watches.end(watch.id)) reached.add(watch.threadId);
    }
    for (const threadId of reached) {
      if (threadId === by.threadId || !(await threads.find(threadId))) continue;
      await notify(threadId, {
        kind: "task.changed",
        source: { threadId: ownerId, name: "Tasks", main: true },
        actor: await actorOf(by),
        ...(what && { change: what }),
        text,
        influence: by.people,
      });
    }
    await tellQuietly(ownerId, by, [before.assignee, after?.assignee], reached, text, what);
  }

  // The list's owner thread and whether the person may change it, for a reader of the thread.
  // The list's owner and whether the reader may change it; from what the access rule read of them
  // when given.
  async function openFor(principal: Principal, threadId: string, read?: Reader) {
    if (read) return { ownerId: await ownerOf(read.thread.id), canEdit: read.can("post") };
    const thread = await props(principal, threadId, "read");
    const ownerId = await ownerOf(thread.id);
    let canEdit = true;
    try {
      await props(principal, thread.id, "post");
    } catch {
      canEdit = false;
    }
    return { ownerId, canEdit };
  }

  async function props(
    principal: Principal,
    threadId: string,
    action: "read" | "post",
  ): Promise<Thread> {
    return (await options.access.require(principal, threadId, action)).thread;
  }

  async function person(principal: Principal): Promise<Influencer> {
    return {
      userId: principal.userId,
      name: (await tasks.userName(principal.userId)) ?? "Someone",
      via: [],
    };
  }

  async function assigneeFor(
    principal: Principal,
    ownerId: string,
    input: NonNullable<TaskChangeInput["assignee"]>,
  ) {
    if (input.kind === "agent") return { kind: "agent" as const };
    if (input.kind === "me") {
      const { userId, name } = await person(principal);
      return { kind: "person" as const, userId, name };
    }
    if (input.kind === "person") {
      if (input.userId === principal.userId) return assigneeFor(principal, ownerId, { kind: "me" });
      const found = (await writersOf(ownerId)).find(
        (one) => one.userId === input.userId && one.canPost,
      );
      if (!found) throw new ServiceError(404, "Person not found");
      return { kind: "person" as const, userId: found.userId, name: found.name };
    }
    const found = (await liveSubagents(ownerId)).find((one) => one.threadId === input.threadId);
    if (!found) throw new ServiceError(404, "Subagent not found");
    return { kind: "subagent" as const, ...found };
  }

  async function mineOrThrow(id: string, ownerId: string) {
    const record = await tasks.find(id);
    if (!record || record.threadId !== ownerId || record.archivedAt) {
      throw new ServiceError(404, "Task not found");
    }
    return record;
  }

  return {
    toolset(): Toolset {
      return {
        id: TASKS_TOOLSET,
        title: "Tasks",
        source: "builtin",
        description: "A task list for the thread's work",
        guidance: TASKS_GUIDANCE,
        tools: [list, add, update, remove, archive, watch],
      };
    },

    // The thread whose list the thread works on.
    ownerOf,

    // What a subagent's start does with the starter's list: checks and gives the tasks it names,
    // and has it work on the list when it was given tasks or asked to share it.
    extension: {
      async check(ownerId: string, taskIds: string[]) {
        const missing = await filterAsync(
          taskIds,
          async (id) => (await tasks.find(id))?.threadId !== ownerId,
        );
        return missing.length > 0 ? `No task ${missing.join(", ")}. Add tasks first.` : null;
      },
      async started(
        subagent: { threadId: string; parentThreadId: string; name: string },
        input: { tasks?: string[]; shareTasks: boolean },
      ) {
        const ownerId = subagent.parentThreadId;
        if (input.shareTasks || input.tasks) await tasks.share(subagent.threadId, ownerId);
        const taskIds = input.tasks ?? [];
        const by = await agentActor(ownerId, (await threads.find(ownerId))?.spaceId ?? "");
        for (const id of taskIds) {
          const record = await tasks.find(id);
          if (!record) continue;
          const next = await tasks.update(id, {
            assignee: { kind: "subagent", threadId: subagent.threadId, name: subagent.name },
            updatedBy: by,
            updatedAt: now(),
          });
          await giveToSubagent(ownerId, next ?? record, by.name, ownerId);
        }
        if (taskIds.length > 0) changed(ownerId);
      },
      async framing(threadId: string) {
        return (await tasks.sharedWith(threadId)) ? { sharesTasks: true as const } : {};
      },
    },

    // The list of the thread, as the reader sees it.
    async listFor(
      principal: Principal,
      threadId: string,
      archived = false,
      read?: Reader,
    ): Promise<TaskList> {
      const { ownerId, canEdit } = await openFor(principal, threadId, read);
      const list = await listOf(ownerId, canEdit, ownerId !== threadId, archived);
      if (!canEdit || list.assignees.length === 0) return list;
      // The reader may post, so a task may be given to them whether or not they have written yet.
      const { userId, name } = await person(principal);
      if (list.assignees.some((one) => one.kind === "person" && one.userId === userId)) return list;
      return { ...list, assignees: [...list.assignees, { kind: "person", userId, name }] };
    },

    async add(principal: Principal, threadId: string, title: string) {
      const thread = await props(principal, threadId, "post");
      const ownerId = await ownerOf(thread.id);
      if ((await tasks.inThread(ownerId)).length >= TASK_LIMIT) {
        throw new ServiceError(409, `A list holds ${TASK_LIMIT} tasks`);
      }
      const by = { kind: "user" as const, ...(await person(principal)) };
      const { via: _via, ...actor } = by;
      const added = await tasks.add([
        {
          id: ulid(),
          threadId: ownerId,
          title,
          status: "todo",
          // A task a person adds is theirs until they say otherwise.
          assignee: { kind: "person", userId: by.userId, name: by.name },
          createdBy: actor,
          updatedBy: actor,
        },
      ]);
      changed(ownerId);
      await announceAdded(ownerId, { name: actor.name, userId: by.userId }, added);
    },

    async change(principal: Principal, threadId: string, taskId: string, change: TaskChangeInput) {
      const thread = await props(principal, threadId, "post");
      const ownerId = await ownerOf(thread.id);
      const before = await mineOrThrow(taskId, ownerId);
      const who = await person(principal);
      const next = await tasks.update(taskId, {
        ...(change.status && { status: change.status }),
        ...(change.title && { title: change.title }),
        ...(change.assignee !== undefined && {
          assignee: await assigneeFor(principal, ownerId, change.assignee),
        }),
        updatedBy: { kind: "user", userId: who.userId, name: who.name },
        updatedAt: now(),
      });
      changed(ownerId);
      if (next?.assignee?.kind === "subagent") await tasks.share(next.assignee.threadId, ownerId);
      await announce(
        ownerId,
        { name: who.name, userId: who.userId, people: [who] },
        before,
        next ?? before,
        change,
      );
    },

    // Archives the list's done tasks, the ones given to the thread's subagent in a thread sharing
    // its starter's list; how many.
    async archiveDone(principal: Principal, threadId: string) {
      const thread = await props(principal, threadId, "post");
      const ownerId = await ownerOf(thread.id);
      const { shown } = await visible(ownerId, thread.id, false);
      const who = await person(principal);
      const archived = await archiveAll(
        ownerId,
        shown.filter((record) => record.status === "done"),
        { kind: "user", userId: who.userId, name: who.name },
      );
      await announceArchive(
        ownerId,
        { name: who.name, userId: who.userId, people: [who] },
        archived,
      );
      return archived.length;
    },

    async remove(principal: Principal, threadId: string, taskId: string) {
      const thread = await props(principal, threadId, "post");
      const ownerId = await ownerOf(thread.id);
      const before = await mineOrThrow(taskId, ownerId);
      await tasks.remove([taskId]);
      changed(ownerId);
      const who = await person(principal);
      await announce(
        ownerId,
        { name: who.name, userId: who.userId, people: [who] },
        before,
        null,
        {},
      );
    },
  };
}
