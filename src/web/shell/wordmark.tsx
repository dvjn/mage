import { cn } from "cn";

export function Wordmark({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="wordmark"
      className={cn("font-sans text-2xl font-bold tracking-tighter text-foreground", className)}
      {...props}
    >
      Mage
    </span>
  );
}
