// An agent reply as it shows: its Markdown, and in place of each `ui` block the layout drawn from
// it, loaded the first time one appears. While the layout's code loads, the block shows its source.

import { lazy, type ReactNode, Suspense } from "react";

import { splitReply } from "@/web/lib/reply-blocks";

// The renderer's development inspector mounts itself into the page unless told it already has.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

const ReplyUi = lazy(() => import("@/web/components/reply-ui"));

export function RichReply({
  text,
  streaming,
  markdown,
}: {
  text: string;
  streaming: boolean;
  // Draws a piece of Markdown; `last` when it ends the reply.
  markdown: (text: string, last: boolean) => ReactNode;
}) {
  const pieces = splitReply(text);
  if (!pieces.some((piece) => piece.kind === "ui")) return markdown(text, true);
  return pieces.map((piece, index) => {
    const last = index === pieces.length - 1;
    if (piece.kind === "markdown") return <div key={index}>{markdown(piece.text, last)}</div>;
    return (
      <Suspense
        key={index}
        fallback={
          <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {piece.source}
          </pre>
        }
      >
        <ReplyUi source={piece.source} streaming={streaming && piece.open} />
      </Suspense>
    );
  });
}
