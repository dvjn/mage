// What schedules and webhooks share in a thread: how many of both it keeps at once, and a page of
// what one fired.

import * as z from "zod";

// How many schedules and webhooks together a thread has active or paused at once.
export const SCHEDULES_AND_WEBHOOKS_LIMIT = 20;

// How many entries of one's history a page holds.
export const HISTORY_PAGE = 10;

// One page of what a schedule fired or a webhook took, newest first: when, the row of the
// notification in the thread, and for a post what it said it was. `total` counts all of it.
export const firedHistorySchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      delivery: z
        .object({
          contentType: z.string().nullable(),
          bytes: z.number().int().nonnegative(),
          signed: z.boolean(),
        })
        .optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});

export type FiredHistory = z.infer<typeof firedHistorySchema>;
