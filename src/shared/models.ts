// The models an org can use, its default model and effort and the model that names threads, and
// which of each connection's models are on, as the API shows them, shared by the server and the
// web client.

import * as z from "zod";

import { effortSchema } from "@/shared/threads.ts";

export const modelSchema = z.object({
  ref: z.string(),
  id: z.string(),
  name: z.string(),
  connectionId: z.string(),
  authKind: z.enum(["codex", "claude", "api_key"]),
  // How people know the connection it comes through.
  connectionLabel: z.string(),
  contextWindow: z.number().optional(),
  reasoning: z.boolean().optional(),
});

export type ModelSummary = z.infer<typeof modelSchema>;

export const modelListSchema = z.object({
  models: z.array(modelSchema),
  errors: z.array(z.object({ connectionId: z.string(), message: z.string() })),
  // Models people turned off, which no picker offers but which threads may still name.
  turnedOff: z.array(z.object({ ref: z.string(), name: z.string(), connectionId: z.string() })),
});

// Whether the model a thread replies with can do so: listed and on, turned off, or gone.
export const modelAvailabilitySchema = z.object({
  ref: z.string(),
  name: z.string(),
  status: z.enum(["ok", "off", "unavailable"]),
});

export type ModelListSummary = z.infer<typeof modelListSchema>;

export const defaultModelSchema = z.object({ ref: z.string().nullable() });

export type DefaultModel = z.infer<typeof defaultModelSchema>;

export const setDefaultModelSchema = z.object({ ref: z.string().min(1) });

// Null for each model's usual effort.
export const defaultEffortSchema = z.object({ effort: effortSchema.nullable() });

export type DefaultEffort = z.infer<typeof defaultEffortSchema>;

// The org's title model, or null to choose automatically, and the model chosen automatically, or
// null for each thread's own model.
export const titleModelSchema = z.object({
  ref: z.string().nullable(),
  automatic: z.string().nullable(),
});

export type TitleModel = z.infer<typeof titleModelSchema>;

export const setTitleModelSchema = z.object({ ref: z.string().min(1).nullable() });

// One connection's models, on or off, with when each was first listed, whether models it adds later
// start on, and, after turning some off, the spaces that still start threads on one of them.
export const connectionModelsSchema = z.object({
  autoEnable: z.boolean(),
  models: z.array(
    modelSchema.extend({
      enabled: z.boolean(),
      firstSeenAt: z.iso.datetime(),
      // The org's default model, which stays on.
      orgDefault: z.boolean(),
    }),
  ),
  spacesUsingOff: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

export type ConnectionModels = z.infer<typeof connectionModelsSchema>;

// Turns models on or off, or sets whether new ones start on.
export const connectionModelsChangeSchema = z
  .object({
    autoEnable: z.boolean().optional(),
    set: z
      .object({ ids: z.array(z.string().min(1)).min(1).max(1000), enabled: z.boolean() })
      .optional(),
  })
  .refine((change) => change.autoEnable !== undefined || change.set !== undefined);
