// Reads a thread's live stream, or a person's inbox stream, in the tests, one frame at a time.

import type { RowsUpdate } from "@/shared/threads/rows.ts";

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
  const frames = framesOf(res);

  // The next rows sent, skipping heartbeats.
  async function nextRows() {
    const frame = await frames.nextItem();
    const update = JSON.parse(frame.data!) as RowsUpdate;
    return { ...update, sseId: frame.id, sseEvent: frame.event };
  }

  return { res, ...frames, nextRows };
}

// Opens the person's inbox stream and reads it one frame at a time.
export async function openInbox(app: ReturnType<typeof setup>["app"], cookie: string) {
  const res = await app.request("/api/v1/inbox/events", { headers: { Cookie: cookie } });
  const frames = framesOf(res);
  // The next item, skipping heartbeats, with its kind and data.
  async function nextInbox() {
    const frame = await frames.nextItem();
    return { event: frame.event, data: JSON.parse(frame.data!) as Record<string, any> };
  }
  return { res, ...frames, nextInbox };
}

function framesOf(res: Response) {
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

  return { next, nextItem, close: () => reader?.cancel() };
}
