// A thread as the API shows it, and how hard its model thinks.

import * as z from "zod";

// How hard a model that can think does so before it answers.
export const effortSchema = z.enum(["low", "medium", "high"]);

export type Effort = z.infer<typeof effortSchema>;

export const threadSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  // The folder it is in, or null at the top of the space.
  folderId: z.string().nullable(),
  title: z.string(),
  // Nobody and nothing has named it yet; its title is then "Untitled".
  untitled: z.boolean(),
  // A model ref, or null to follow its space's default, then its org's.
  model: z.string().nullable(),
  // The reasoning effort its model is asked for, or null to follow its space's default, then its
  // org's, then the model's usual one.
  effort: effortSchema.nullable(),
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ThreadSummary = z.infer<typeof threadSchema>;

// What an untitled thread is called, and found by.
export const UNTITLED = "Untitled";
