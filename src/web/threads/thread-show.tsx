// Chooses which of a page's threads it lists: all of them, those that need the reader (the agent
// waits for their decision, or failed since they looked), or those with something new for them.

import type { ThreadShow } from "@/shared/thread-status.ts";
import { SegmentedControl } from "@/web/components/segmented-control";

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
