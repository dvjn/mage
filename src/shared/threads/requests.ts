// The bodies that make a thread, post and change its messages, and act on it.

import * as z from "zod";

import { commandInputSchema } from "@/shared/threads/commands.ts";
import { deliverySchema, toolScopeSchema } from "@/shared/threads/events.ts";
import { effortSchema } from "@/shared/threads/thread.ts";

const messageTextSchema = z.string().trim().min(1).max(100_000);

export const messageInputSchema = z.object({
  text: messageTextSchema,
  mode: deliverySchema.default("steer"),
  // The command the text starts with, when it is sent as one.
  command: commandInputSchema.optional(),
});

// A change to a message still waiting: its text, or steering instead of queueing or back.
export const pendingChangeSchema = z
  .object({
    text: messageTextSchema.optional(),
    mode: z.enum(["steer", "queue"]).optional(),
  })
  .refine((change) => change.text !== undefined || change.mode !== undefined);

// A new thread: its first message, its folder, and the model and effort it starts with instead of
// its space's defaults.
export const newThreadSchema = z.object({
  text: messageTextSchema.optional(),
  folderId: z.string().min(1).nullable().optional(),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
});

export const threadUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  // Null follows the space's default model.
  model: z.string().min(1).nullable().optional(),
  // Null follows the space's default effort.
  effort: effortSchema.nullable().optional(),
  // Null moves the thread to the top of its space.
  folderId: z.string().min(1).nullable().optional(),
});

// The space a thread moves to, at its top.
export const threadMoveSchema = z.object({ spaceId: z.string().min(1) });

// A person's decision on a tool call waiting for one.
export const toolDecisionSchema = z.object({
  allow: z.boolean(),
  scope: toolScopeSchema.default("once"),
});

// How far into the thread the reader has seen.
export const threadReadSchema = z.object({ seq: z.number().int().nonnegative() });

// The run whose reply to try again.
export const retrySchema = z.object({ runId: z.string().min(1) });
