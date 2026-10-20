// A moment shown as how long ago it was, with the full date and time on hover.

import { fullTime, timeAgo } from "@/web/lib/time";

export function Time({ iso, ...props }: { iso: string } & React.ComponentProps<"time">) {
  return (
    <time dateTime={iso} title={fullTime(iso)} {...props}>
      {timeAgo(iso)}
    </time>
  );
}
