// A moment shown as how long ago it was, in words or in a few characters, and when access ends as
// how long until then, all kept current each minute, with the full date and time on hover.

import { useMinute } from "@/web/hooks/use-minute";
import { fullTime, shortTimeAgo, timeAgo, timeUntil } from "@/web/lib/time";

export function Time({ iso, ...props }: { iso: string } & React.ComponentProps<"time">) {
  useMinute();
  return (
    <time dateTime={iso} title={fullTime(iso)} {...props}>
      {timeAgo(iso)}
    </time>
  );
}

// "4m", with the words for those who cannot see it.
export function ShortTime({ iso, ...props }: { iso: string } & React.ComponentProps<"time">) {
  useMinute();
  return (
    <time dateTime={iso} title={fullTime(iso)} aria-label={timeAgo(iso)} {...props}>
      {shortTimeAgo(iso)}
    </time>
  );
}

// "Ends in 3 hours"; "No expiry" for access that does not end.
export function Until({ iso, ...props }: { iso: string | null } & React.ComponentProps<"span">) {
  useMinute();
  if (!iso) return <span {...props}>No expiry</span>;
  return (
    <span title={fullTime(iso)} {...props}>
      Ends {timeUntil(iso) ?? "now"}
    </span>
  );
}
