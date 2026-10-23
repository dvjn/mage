// The one reasoning effort picker: the default first, named "Default · X", then low, medium and
// high. As a form field it fills its row; compact, it is a composer button. Its popup is as wide as
// its longest choice.

import { cn } from "cn";

import { type Effort, effortSchema } from "@/shared/threads.ts";
import { promptInputSelectTriggerClassName } from "@/web/components/ai-elements/prompt-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Skeleton } from "@/web/components/ui/skeleton";

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

// The select's value while the default is followed.
const DEFAULT = "default";

export function EffortPicker({
  id,
  value,
  onChange,
  defaultLabel,
  disabled,
  loading,
  variant = "field",
  className,
}: {
  id?: string;
  // Null follows the default.
  value: Effort | null;
  onChange: (effort: Effort | null) => void;
  // The default as it reads, as "Default · Medium".
  defaultLabel: string;
  disabled?: boolean;
  // Shows a placeholder in the trigger until what it shows is known.
  loading?: boolean;
  variant?: "field" | "compact";
  className?: string;
}) {
  return (
    <Select
      value={value ?? DEFAULT}
      onValueChange={(next) => {
        if (next === DEFAULT) onChange(null);
        const effort = effortSchema.safeParse(next);
        if (effort.success) onChange(effort.data);
      }}
      disabled={disabled || loading}
    >
      <SelectTrigger
        id={id}
        aria-label="Reasoning effort"
        size={variant === "compact" ? "sm" : "default"}
        className={cn(
          variant === "compact" ? promptInputSelectTriggerClassName : "w-full",
          className,
        )}
      >
        {loading ? (
          <Skeleton className="h-3.5 w-20" />
        ) : (
          <SelectValue>
            {(next: string) =>
              next === DEFAULT ? defaultLabel : (EFFORT_LABELS[next as Effort] ?? next)
            }
          </SelectValue>
        )}
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        {...(variant === "compact" && { side: "top" as const })}
        className="w-auto min-w-(--anchor-width)"
      >
        <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
        <SelectSeparator />
        {effortSchema.options.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {EFFORT_LABELS[effort]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
