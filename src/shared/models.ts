// The models an org can use and its default model, as the API shows them, shared by the server
// and the web client.

import * as z from "zod";

export const modelSchema = z.object({
  ref: z.string(),
  id: z.string(),
  name: z.string(),
  connectionId: z.string(),
  authKind: z.enum(["codex", "claude"]),
  contextWindow: z.number().optional(),
  reasoning: z.boolean().optional(),
});

export type ModelSummary = z.infer<typeof modelSchema>;

export const modelListSchema = z.object({
  models: z.array(modelSchema),
  errors: z.array(z.object({ connectionId: z.string(), message: z.string() })),
});

export type ModelListSummary = z.infer<typeof modelListSchema>;

export const defaultModelSchema = z.object({ ref: z.string().nullable() });

export type DefaultModel = z.infer<typeof defaultModelSchema>;

export const setDefaultModelSchema = z.object({ ref: z.string().min(1) });
