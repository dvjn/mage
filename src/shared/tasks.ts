// Tasks: the list of what a thread's work is made of, kept by the agent and the people in the
// thread, where each task stands and whom it is for.

import * as z from "zod";

// The tools the agent keeps the list with.
export const TASKS_TOOLSET = "tasks";
export const LIST_TASKS = "tasks.list";
export const ADD_TASKS = "tasks.add";
export const ARCHIVE_TASKS = "tasks.archive";
export const WATCH_TASKS = "tasks.watch";
// What the model calls the list's reader, for text made outside a run.
export const LIST_TASKS_MODEL_NAME = "thread.list_tasks";

// How many tasks a list holds, and how many one call adds.
export const TASK_LIMIT = 50;
export const ADD_LIMIT = 20;

export const taskStatusSchema = z.enum(["todo", "doing", "done"]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

// Whom a task is for: the thread's agent, a subagent by its thread, or a person.
export const taskAssigneeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({ kind: z.literal("subagent"), threadId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("person"), userId: z.string(), name: z.string() }),
]);

export type TaskAssignee = z.infer<typeof taskAssigneeSchema>;

// Who made or last changed a task: a person, or an agent by the name it goes by.
export const taskActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), name: z.string() }),
  z.object({ kind: z.literal("user"), userId: z.string(), name: z.string() }),
]);

export type TaskActor = z.infer<typeof taskActorSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  // Every task is for someone: whoever made it, until it is given to another.
  assignee: taskAssigneeSchema,
  order: z.number().int(),
  createdBy: taskActorSchema,
  updatedBy: taskActorSchema,
  updatedAt: z.string(),
});

export type Task = z.infer<typeof taskSchema>;

// Whom a task may be given to: the agent, a live subagent, or a person who may post in the thread.
export const taskCandidateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), name: z.string() }),
  z.object({ kind: z.literal("subagent"), threadId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("person"), userId: z.string(), name: z.string() }),
]);

export type TaskCandidate = z.infer<typeof taskCandidateSchema>;

// A thread's list as its reader sees it: the tasks, whether they may change them, the subagents a
// task may be given to and everyone it may be given to. The archived list is read-only.
export const taskListSchema = z.object({
  tasks: z.array(taskSchema),
  canEdit: z.boolean(),
  subagents: z.array(z.object({ threadId: z.string(), name: z.string() })),
  assignees: z.array(taskCandidateSchema),
  // Set when the thread is a subagent working on its starter's list: its own tasks come first.
  shared: z.boolean().optional(),
});

export type TaskList = z.infer<typeof taskListSchema>;

export const titleSchema = z.string().trim().min(1).max(200);

// Whom a person gives a task to: the agent, a subagent, themselves or a person who may post.
export const taskAssignInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({ kind: z.literal("subagent"), threadId: z.string() }),
  z.object({ kind: z.literal("me") }),
  z.object({ kind: z.literal("person"), userId: z.string() }),
]);

export const taskAddInputSchema = z.object({ title: titleSchema });

export const taskChangeInputSchema = z.object({
  title: titleSchema.optional(),
  status: taskStatusSchema.optional(),
  assignee: taskAssignInputSchema.optional(),
});

export type TaskChangeInput = z.infer<typeof taskChangeInputSchema>;

// What archiving the done tasks of a list did.
export const taskArchiveResultSchema = z.object({ archived: z.number().int() });
