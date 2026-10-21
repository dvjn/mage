// A moment shown as how long ago it was, kept current each minute, with the full date and time on
// hover.

import { useMinute } from "@/web/hooks/use-minute";
import { fullTime, timeAgo } from "@/web/lib/time";

export function Time({ iso, ...props }: { iso: string } & React.ComponentProps<"time">) {
  useMinute();
  return (
    <time dateTime={iso} title={fullTime(iso)} {...props}>
      {timeAgo(iso)}
    </time>
  );
}
