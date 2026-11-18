// Webhooks: addresses outside services post to, each of which wakes the thread's agent it was made
// in whenever something posts to it, telling it what was posted.

import * as z from "zod";

// The toolset and the tool the agent makes them with.
export const WEBHOOKS_TOOLSET = "webhooks";
export const ADD_WEBHOOK = "webhooks.add";
export const LIST_WEBHOOKS = "webhooks.list";
export const DELETE_WEBHOOK = "webhooks.delete";

// Where a webhook receives posts, under the API but outside what needs a login; the token after it
// is the whole of the address's secrecy.
export const HOOK_PATH = "/api/hooks/";

// The most a webhook takes in one post, in bytes, and the most of it the agent is shown, in characters.
export const HOOK_BODY_LIMIT = 256 * 1024;
export const HOOK_PAYLOAD_SHOWN = 20_000;

// The header a post's signature comes in when the webhook has a signing secret: "sha256=" and the
// hex HMAC-SHA256 of the body, as GitHub sends it.
export const HOOK_SIGNATURE_HEADER = "X-Hub-Signature-256";

// The headers a sender gives a delivery's id in, the first present counting: a retry of the same
// delivery carries the same id and is taken once.
export const DELIVERY_HEADERS = ["Webhook-Id", "X-GitHub-Delivery", "Idempotency-Key"] as const;

// A webhook as its card shows it. The signing secret itself is never sent, only whether there is one.
export const webhookWorkSchema = z.object({
  id: z.string(),
  name: z.string(),
  // The address's path, for those who may change it; the card adds the origin it is opened from.
  path: z.string().optional(),
  signed: z.boolean(),
  // The header its sender gives a delivery's id in, where one was named.
  deliveryHeader: z.string().optional(),
  lastFiredAt: z.string().optional(),
  // How many posts it has taken, which its history lists.
  fired: z.number().int().nonnegative(),
  canChange: z.boolean(),
});

export type WebhookWork = z.infer<typeof webhookWorkSchema>;

// What a person sends to set or clear a webhook's signing secret.
export const hookSecretInputSchema = z.object({ secret: z.string().max(200).nullable() });

// What a person sends to name the header a webhook's deliveries carry their id in, or with null to
// go back to the usual ones.
export const hookDeliveryHeaderInputSchema = z.object({
  header: z.string().max(100).nullable(),
});

// Whether the text is a header's name.
export function isHeaderName(name: string) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}
