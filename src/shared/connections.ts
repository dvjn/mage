// Connections as the API shows them, the bodies of the sign-ins that make them and of the proxies
// their requests can go through, shared by the server and the web client. Credentials and proxy
// header values never leave the server.

import * as z from "zod";

// A connection's proxy as the API shows it: the base URL and the names of its headers, never
// their values.
export const proxySummarySchema = z.object({
  baseUrl: z.string().nullable(),
  headerNames: z.array(z.string()),
});

export type ProxySummary = z.infer<typeof proxySummarySchema>;

export const connectionSchema = z.object({
  id: z.string(),
  provider: z.enum(["openai", "anthropic"]),
  authKind: z.enum(["codex", "claude"]),
  account: z.string(),
  // Null when its requests go to the provider as usual.
  proxy: proxySummarySchema.nullable(),
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

// Header names Mage sets itself, which a proxy may not change.
export const OWNED_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "anthropic-version",
  "anthropic-beta",
  "content-type",
  "host",
];

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// A connection's proxy as it is set: an http(s) base URL or null for the provider's own, and its
// headers by name, where a null value keeps the value already stored. Headers left out are
// removed. Names are kept in lower case.
export const proxyInputSchema = z.object({
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .transform((url) => url.replace(/\/+$/, ""))
    .nullable(),
  headers: z
    .record(
      z.string(),
      z
        .string()
        .min(1, "Give each header a value")
        .max(4000)
        .regex(/^[^\r\n]*$/, "Header values are one line")
        .nullable(),
    )
    .superRefine((headers, ctx) => {
      const names = Object.keys(headers).map((name) => name.toLowerCase());
      if (names.length > 20) ctx.addIssue({ code: "custom", message: "At most 20 headers" });
      if (new Set(names).size !== names.length) {
        ctx.addIssue({ code: "custom", message: "Each header once" });
      }
      for (const name of names) {
        if (!HEADER_NAME.test(name)) {
          ctx.addIssue({ code: "custom", message: `${name} is not a header name` });
        } else if (OWNED_HEADERS.includes(name)) {
          ctx.addIssue({ code: "custom", message: `Mage sets ${name} itself` });
        }
      }
    })
    .transform((headers) =>
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    ),
});

export type ProxyInput = z.infer<typeof proxyInputSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
