// The live streams the server sends the web client: where each is read from, and every event it
// sends with the shape of its data.

import { z } from "zod";

import { artifactEventSchema } from "./artifacts.ts";
import { activityListSchema } from "./jobs.ts";
import { taskListSchema } from "./tasks.ts";
import { threadHeadSchema } from "./threads/detail.ts";
import { deltaBatchSchema, liveChunkSchema } from "./threads/events.ts";
import { threadListItemSchema } from "./threads/list.ts";
import { rowsUpdateSchema } from "./threads/rows.ts";

// Sent as a stream ends because its reader may no longer read what it follows.
const accessEnded = z.object({});

export const STREAMS = {
  // One thread, for a reader with it open.
  thread: {
    path: "/v1/threads/:id/events",
    events: {
      rows: rowsUpdateSchema,
      thread: threadHeadSchema,
      tasks: taskListSchema,
      activity: activityListSchema,
      "message-delta": deltaBatchSchema,
      "tool-output": liveChunkSchema,
      "access-ended": accessEnded,
    },
  },
  // A person's thread lists.
  feed: {
    path: "/v1/threads/feed",
    events: {
      thread: z.object({ thread: threadListItemSchema, shared: z.boolean() }),
      "thread-read": z.object({ threadId: z.string(), seq: z.number() }),
      "thread-gone": z.object({ threadId: z.string() }),
    },
  },
  // One artifact, for a viewer with it open; its events are named by their type.
  artifact: {
    path: "/v1/artifacts/:id/events",
    events: {
      published: artifactEventSchema,
      sharing: artifactEventSchema,
      deleted: artifactEventSchema,
      "access-ended": accessEnded,
    },
  },
} as const;
