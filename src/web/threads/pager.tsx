// Pages for the lists of the activity tray's panel: one page of rows at a time, with a compact
// control that says which and steps between them, so the panel keeps its height. The control is not
// there when everything fits on one page. A panel list publishes its pager to the panel's header,
// which shows the control; a nested list shows it on its own row.

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";

// How many rows a page holds: what fits the panel's height.
export const TRAY_PAGE = 5;

// One page of a list held in full, and what its control needs.
export function usePager<T>(items: readonly T[], size = TRAY_PAGE) {
  const [asked, setAsked] = useState(0);
  // A list that shrank leaves its last page, not an empty one.
  const offset = Math.min(asked, Math.max(0, Math.ceil(items.length / size) - 1) * size);
  return {
    items: items.slice(offset, offset + size),
    pager: { offset, size, total: items.length, onOffset: setAsked },
  };
}

export interface PagerState {
  offset: number;
  size: number;
  total: number;
  onOffset: (offset: number) => void;
}

// The least height of a page of rows, so the panel does not shrink on a short last page.
export function pageHeight({ size, total }: Pick<PagerState, "size" | "total">) {
  return total > size ? { minHeight: `${size * 2.75}rem` } : undefined;
}

// Where the panel's list publishes its pager for the header to show.
export const PagerSlotContext = createContext<(pager: PagerState | null) => void>(() => {});

export function usePublishPager({ offset, size, total, onOffset }: PagerState) {
  const publish = useContext(PagerSlotContext);
  useEffect(() => {
    publish({ offset, size, total, onOffset });
  }, [publish, offset, size, total, onOffset]);
  useEffect(() => () => publish(null), [publish]);
}

export function PagerControl({
  offset,
  size,
  total,
  onOffset,
  before = "Previous",
  after = "Next",
}: PagerState & {
  // What the buttons are called: the page before and the page after.
  before?: string;
  after?: string;
}) {
  if (total <= size) return null;
  const last = Math.min(offset + size, total);
  return (
    <div
      className="flex shrink-0 items-center justify-end gap-0.5 text-xs text-muted-foreground"
      data-testid="pager"
    >
      <span className="mr-1 tabular-nums">
        {offset + 1}–{last} of {total}
      </span>
      <WithTooltip label={before}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={before}
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - size))}
        >
          <ChevronLeftIcon />
        </Button>
      </WithTooltip>
      <WithTooltip label={after}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={after}
          disabled={last >= total}
          onClick={() => onOffset(offset + size)}
        >
          <ChevronRightIcon />
        </Button>
      </WithTooltip>
    </div>
  );
}
