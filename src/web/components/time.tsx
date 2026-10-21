// A moment shown as how long ago it was, and when access ends as how long until then, both kept
// current each minute, with the full date and time on hover.

import { useMinute } from "@/web/hooks/use-minute";
import { fullTime, timeAgo, timeUntil } from "@/web/lib/time";

export function Time({ iso, ...props }: { iso: string } & React.ComponentProps<"time">) {
  useMinute();
  return (
    <time dateTime={iso} title={fullTime(iso)} {...props}>
      {timeAgo(iso)}
    </time>
  );
}

// "ends in 3 hours"; "no expiry" for access that does not end.
export function Until({ iso, ...props }: { iso: string | null } & React.ComponentProps<"span">) {
  useMinute();
  if (!iso) return <span {...props}>no expiry</span>;
  return (
    <span title={fullTime(iso)} {...props}>
      ends {timeUntil(iso) ?? "now"}
    </span>
  );
}
