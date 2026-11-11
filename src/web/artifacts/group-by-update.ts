// Groups items, newest first, under when they were last updated: today, within the last week,
// this month, then one group per earlier month. A group continues across the items it is given.

export interface UpdateGroup<T> {
  heading: string;
  items: T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function groupByUpdate<T extends { updatedAt: string }>(
  items: readonly T[],
  now = new Date(),
): UpdateGroup<T>[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: UpdateGroup<T>[] = [];
  for (const item of items) {
    const at = new Date(item.updatedAt);
    let heading: string;
    if (at.getTime() >= startOfToday) heading = "Today";
    else if (at.getTime() >= startOfToday - 6 * DAY_MS) heading = "This week";
    else if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()) {
      heading = "This month";
    } else {
      const month = at.toLocaleString("en", { month: "long" });
      heading = at.getFullYear() === now.getFullYear() ? month : `${month} ${at.getFullYear()}`;
    }
    const last = groups.at(-1);
    if (last?.heading === heading) last.items.push(item);
    else groups.push({ heading, items: [item] });
  }
  return groups;
}
