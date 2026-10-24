// Which of a page's threads it lists: all of them, those that need the reader (the agent waits for
// their decision, or failed since they looked), or those with something new for them.

import { needsYou, type ThreadStatus } from "@/shared/thread-status.ts";
import { SegmentedControl } from "@/web/components/segmented-control";

export type ThreadShow = "needs-you" | "unread";

export function shows(show: ThreadShow | undefined, status: ThreadStatus) {
  if (show === "needs-you") return needsYou(status);
  if (show === "unread") return status === "unread";
  return true;
}

export function ThreadShowControl({
  value,
  onChange,
}: {
  value: ThreadShow | undefined;
  onChange: (show: ThreadShow | undefined) => void;
}) {
  return (
    <SegmentedControl
      label="Show"
      options={[
        { value: "all", label: "All" },
        { value: "needs-you", label: "Needs you" },
        { value: "unread", label: "Unread" },
      ]}
      value={value ?? "all"}
      onChange={(next) => onChange(next === "all" ? undefined : next)}
    />
  );
}
