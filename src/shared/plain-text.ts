// Markdown as the text it shows, and the text of a message or reply on one line, shared by the
// server's titles and the thread lists that find threads by their newest message.

// Markdown as the text it shows: without code fences, heading, quote and list markers, emphasis
// and inline code marks, and with links and images as their text.
export function plainText(markdown: string) {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|~~|\*|`+)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|\W)(__|_)(\S(?:.*?\S)?)\2(?=\W|$)/g, "$1$3");
}

// The text parts of a message or reply without markdown, on one line.
export function spokenText(parts: readonly { type: string; text?: string }[]) {
  return plainText(
    parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// The first line of markdown that says something: not blank, a code fence or a bare heading
// marker, and without its heading marker.
export function previewLine(markdown: string) {
  for (const line of markdown.split("\n")) {
    const text = line.trim();
    if (!text || /^(```|~~~)/.test(text)) continue;
    const stripped = text.replace(/^#{1,6}\s*/, "");
    if (stripped) return stripped;
  }
  return "";
}
