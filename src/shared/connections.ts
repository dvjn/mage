// Connections as the API shows them, and the bodies of the sign-ins that make them, shared by the
// server and the web client. Credentials never leave the server.

import * as z from "zod";

export const connectionSchema = z.object({
  id: z.string(),
  provider: z.enum(["openai", "anthropic"]),
  authKind: z.enum(["codex", "claude"]),
  account: z.string(),
  createdAt: z.iso.datetime(),
});

export type ConnectionSummary = z.infer<typeof connectionSchema>;

export const connectionListSchema = z.array(connectionSchema);

export const deviceStartSchema = z.object({
  attemptId: z.string(),
  verificationUrl: z.url(),
  userCode: z.string(),
});

export const browserStartSchema = z.object({ attemptId: z.string(), authorizeUrl: z.url() });

// The callback address or the code; the attempt id finds the sign-in when there is no state.
export const browserFinishSchema = z.object({
  attemptId: z.string().min(1).optional(),
  callbackUrl: z.string().min(1),
});

export const attemptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("connected"), connection: connectionSchema }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);

export type AttemptSummary = z.infer<typeof attemptSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
