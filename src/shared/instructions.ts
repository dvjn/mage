// The instructions an org and a space give the agent, as the API shows them and takes them: their
// text, and the most they may hold. Long ones are worth a warning, as they go with every message.

import * as z from "zod";

export const INSTRUCTIONS_MAX = 50_000;
export const INSTRUCTIONS_LONG = 20_000;

export const instructionsSchema = z.object({
  text: z.string(),
  updatedAt: z.iso.datetime().nullable(),
});

export type Instructions = z.infer<typeof instructionsSchema>;

// A space's own, and the org's it follows first.
export const spaceInstructionsSchema = z.object({
  own: instructionsSchema,
  org: instructionsSchema,
});

export type SpaceInstructions = z.infer<typeof spaceInstructionsSchema>;

export const instructionsInputSchema = z.object({
  text: z.string().max(INSTRUCTIONS_MAX, "These instructions are too long to save. Shorten them."),
});
