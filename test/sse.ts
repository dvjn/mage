// Reads a thread's live event stream in the tests, one frame at a time.

import type { ThreadEventSummary } from "@/shared/threads.ts";

import type { setup } from "./workspace.ts";

type Frame = { id?: string; event?: string; data?: string; comment?: string };

// Opens a thread's live event stream and reads it one frame at a time.
export async function openStream(
  app: ReturnType<typeof setup>["app"],
  cookie: string,
  threadId: string,
  cursor: { after?: number; lastEventId?: string } = {},
) {
  const query = cursor.after === undefined ? "" : `?after=${cursor.after}`;
  const res = await app.request(`/api/v1/threads/${threadId}/events${query}`, {
    headers: { Cookie: cookie, ...(cursor.lastEventId && { "Last-Event-ID": cursor.lastEventId }) },
  });
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  async function next(): Promise<Frame> {
    if (!reader) throw new Error("no body");
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += value;
    }
    const end = buffer.indexOf("\n\n");
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const frame: Frame = {};
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) frame.comment = line.slice(1).trim();
      const [field, ...rest] = line.split(": ");
      if (field === "id" || field === "event" || field === "data") frame[field] = rest.join(": ");
    }
    return frame;
  }

  // The next event or reply pieces, skipping heartbeats.
  async function nextItem() {
    for (;;) {
      const frame = await next();
      if (frame.data) return frame;
    }
  }

  // The next event, skipping heartbeats.
  async function nextEvent() {
    const frame = await nextItem();
    const event = JSON.parse(frame.data!) as ThreadEventSummary;
    return { ...event, sseId: frame.id, sseEvent: frame.event };
  }

  return { res, next, nextItem, nextEvent, close: () => reader?.cancel() };
}
