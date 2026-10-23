// The one segmented control: a row of options of which exactly one is chosen, for a scope or a way
// of doing something.

import { ToggleGroup, ToggleGroupItem } from "@/web/components/ui/toggle-group";

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      size="sm"
      spacing={1}
      value={[value]}
      onValueChange={(next: string[]) => {
        // One stays chosen: pressing the chosen one again changes nothing.
        const chosen = next.find((option) => option !== value) ?? next[0];
        if (chosen) onChange(chosen as T);
      }}
      className={className}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="max-w-48 text-muted-foreground aria-pressed:text-foreground"
        >
          <span className="truncate">{option.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
