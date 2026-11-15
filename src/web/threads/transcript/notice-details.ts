// What a webhook's card shows when opened: its payload as a code block, with what is known of the
// post.

import type { NoticeRow } from "@/shared/threads/rows.ts";

// A webhook's payload as stored: after a Content-Type line when the sender gave one.
export function payloadOf(row: Pick<NoticeRow, "last" | "delivery">) {
  const last = row.last ?? "";
  const header = /^Content-Type: ([^\n]*)\n\n/.exec(last);
  const body = header ? last.slice(header[0].length) : last;
  const contentType = row.delivery?.contentType ?? header?.[1] ?? null;
  let text = body;
  let language = "text";
  try {
    text = JSON.stringify(JSON.parse(body), null, 2);
    language = "json";
  } catch {
    // Not JSON, or cut short: shown as it came.
  }
  return { text, language, contentType };
}

// The payload as a fenced block that its own backticks cannot end.
export function fenced(text: string, language: string) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
