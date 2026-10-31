// An agent reply's text as the pieces it shows in: Markdown, and the layouts it wrote in fenced
// blocks whose language is `ui`. A block still open at the end of the text is one still being
// written.

export const UI_FENCE = "ui";

export type ReplyPiece =
  | { kind: "markdown"; text: string }
  | { kind: "ui"; source: string; open: boolean };

// A fence line that opens a layout, and the line that closes any fence.
const OPENS = /^ {0,3}```ui[ \t]*$/;
const CLOSES = /^ {0,3}```[ \t]*$/;

export function splitReply(text: string): ReplyPiece[] {
  const pieces: ReplyPiece[] = [];
  const lines = text.split("\n");
  let markdown: string[] = [];
  let block: string[] | null = null;
  // Inside some other fenced block, where a `ui` fence is only text.
  let fenced = false;
  const flush = () => {
    if (markdown.length > 0 && markdown.join("\n").trim()) {
      pieces.push({ kind: "markdown", text: markdown.join("\n") });
    }
    markdown = [];
  };
  for (const line of lines) {
    if (block) {
      if (CLOSES.test(line)) {
        pieces.push({ kind: "ui", source: block.join("\n"), open: false });
        block = null;
      } else {
        block.push(line);
      }
      continue;
    }
    if (!fenced && OPENS.test(line)) {
      flush();
      block = [];
      continue;
    }
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    markdown.push(line);
  }
  if (block) pieces.push({ kind: "ui", source: block.join("\n"), open: true });
  flush();
  return pieces;
}

export function hasUiBlock(text: string) {
  return splitReply(text).some((piece) => piece.kind === "ui");
}
