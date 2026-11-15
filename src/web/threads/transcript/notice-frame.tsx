// A notification's row: its card on the right, with the actor's avatar beside it and the row's
// toolbar below. The card is the bubble, built on the transcript's shared card frame.
import type { ReactNode } from "react";

import { TranscriptRowFrame } from "@/web/threads/transcript/row-frame";
import { type Source, SourceCard } from "@/web/threads/transcript/source-card";

export function NoticeFrame({
  rowId,
  label = "Notice",
  source,
  actions,
  children,
}: {
  rowId?: string;
  label?: string;
  source: Source;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TranscriptRowFrame
      rowId={rowId}
      human
      card
      avatar={<SourceCard source={source} />}
      author={source.name}
      label={label}
      actions={actions}
    >
      {children}
    </TranscriptRowFrame>
  );
}
