// Keeps a thread's cached rows as the server sends them: a row already here is replaced by id, one
// newer than the newest here is added in its place, and one before the rows here is left out until
// its page is read; a page of earlier rows goes before the first here. A fresh read keeps the earlier
// pages read so far and the live rows that arrived while it was on its way. Newer changes of a row
// win, as its seq says. Another branch made current replaces them all.

import type { BackgroundItem } from "@/shared/calls.ts";
import type { ThreadDetail, ThreadHead } from "@/shared/threads/detail.ts";
import { ROWS_PAGE, type RowsPage, type RowsUpdate, type ShownRow } from "@/shared/threads/rows.ts";

// The rows with the changed ones in: each replacing the row with its id unless that one is newer,
// or, with `ties` false, as new; or added when it comes after every row here; in order. Live rows
// win ties, since the parts of a row that are the reader's change without its seq.
export function withChangedRows(rows: ShownRow[], changed: ShownRow[], ties = true): ShownRow[] {
  if (changed.length === 0) return rows;
  const next = [...rows];
  const at = new Map(rows.map((row, index) => [row.id, index]));
  const newest = rows.at(-1)?.order ?? -1;
  let added = false;
  for (const row of changed) {
    const index = at.get(row.id);
    if (index !== undefined) {
      const here = next[index]!.seq;
      if (here < row.seq || (ties && here === row.seq)) next[index] = row;
    } else if (row.order > newest) {
      at.set(row.id, next.length);
      next.push(row);
      added = true;
    }
  }
  return added ? next.toSorted((a, b) => a.order - b.order) : next;
}

// The detail with what the live stream sent: the changed rows, the waiting messages and the run,
// and the newest event it reaches; or, once another branch is current, its rows in place of all.
export function withUpdate(detail: ThreadDetail, update: RowsUpdate): ThreadDetail {
  const lastEventSeq = Math.max(detail.thread.lastEventSeq, update.seq);
  const { reset } = update;
  return {
    ...detail,
    thread: { ...detail.thread, lastEventSeq },
    rows: reset ? update.rows : withChangedRows(detail.rows, update.rows),
    ...(reset && {
      branch: reset.branch,
      before: reset.before,
      newFrom: null,
      earlierUnread: 0,
    }),
    waiting: update.waiting,
    run: update.run,
  };
}

// The detail with the thread as the server now has it, keeping the newest event it knows.
export function withHead(detail: ThreadDetail, head: ThreadHead): ThreadDetail {
  const lastEventSeq = Math.max(detail.thread.lastEventSeq, head.thread.lastEventSeq);
  return { ...detail, ...head, thread: { ...head.thread, lastEventSeq } };
}

// The detail with each background call's row showing the job as the dock's feed has it now, since
// a job ends without its row changing.
export function withBackground(detail: ThreadDetail, items: BackgroundItem[]): ThreadDetail {
  const jobs = new Map(
    items.filter((item) => item.work.kind === "call").map((item) => [item.rowId, item.work]),
  );
  let changed = false;
  const rows = detail.rows.map((row) => {
    if (row.kind !== "tool") return row;
    const work = row.background ? jobs.get(row.id) : undefined;
    if (!work || JSON.stringify(work) === JSON.stringify(row.background)) return row;
    changed = true;
    return { ...row, background: work };
  });
  return changed ? { ...detail, rows } : detail;
}

// The detail with a page of earlier rows before the first here.
export function withEarlier(detail: ThreadDetail, page: RowsPage): ThreadDetail {
  const first = detail.rows[0]?.order ?? Infinity;
  const earlier = page.rows.filter((row) => row.order < first);
  return {
    ...detail,
    rows: [...earlier, ...detail.rows],
    before: page.before,
    earlierUnread: page.earlierUnread,
  };
}

// The detail cut to its newest page of rows, where it holds more, with `before` where that page
// starts: what a thread keeps once the reader leaves it or it is stored.
export function withLatestPage<T extends { rows: ShownRow[]; before: number | null }>(
  detail: T,
): T {
  if (detail.rows.length <= ROWS_PAGE) return detail;
  const rows = detail.rows.slice(-ROWS_PAGE);
  return { ...detail, rows, before: rows[0]!.order };
}

// The fresh read, with the rows shown so far that it does not reach: the earlier pages read, when
// they meet its rows, and the live rows newer than its own. Everything else is the server's.
export function withFreshRead(fetched: ThreadDetail, shown: ThreadDetail): ThreadDetail {
  const first = fetched.rows[0]?.order;
  // Rows of another branch have nothing to do with these.
  if (first === undefined || fetched.branch.id !== shown.branch.id) return fetched;
  const meets = (shown.rows.at(-1)?.order ?? -1) + 1 >= first;
  const earlier = meets ? shown.rows.filter((row) => row.order < first) : [];
  const rows = withChangedRows(
    [...earlier, ...fetched.rows],
    shown.rows.filter((row) => row.order >= first),
    false,
  );
  const before = earlier.length > 0 ? shown.before : fetched.before;
  const earlierUnread = earlier.length > 0 ? shown.earlierUnread : fetched.earlierUnread;
  // Live updates that came after the server answered say what waits and runs now.
  const live = shown.thread.lastEventSeq > fetched.thread.lastEventSeq;
  if (
    !live &&
    rows.length === fetched.rows.length &&
    rows.every((row, i) => row === fetched.rows[i])
  ) {
    return fetched;
  }
  return {
    ...fetched,
    rows,
    before,
    earlierUnread,
    ...(live && {
      thread: { ...fetched.thread, lastEventSeq: shown.thread.lastEventSeq },
      waiting: shown.waiting,
      run: shown.run,
    }),
  };
}
