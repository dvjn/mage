// A thread's title, or "Untitled" muted and in italics while nothing has named it.

import { cn } from "cn";

export function ThreadTitle({
  thread,
  className,
}: {
  thread: { title: string; untitled: boolean };
  className?: string;
}) {
  return (
    <span className={cn(thread.untitled && "text-muted-foreground italic", className)}>
      {thread.title}
    </span>
  );
}
