// Above the rows read, where earlier ones the reader has not seen wait: a line across the top that
// reads them back when pressed.

import { useState } from "react";

export function EarlierUnread({
  count,
  onLoad,
}: {
  count: number;
  onLoad: () => Promise<unknown>;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <button
        type="button"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          void onLoad().finally(() => setLoading(false));
        }}
        className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        {count} earlier unread
      </button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
