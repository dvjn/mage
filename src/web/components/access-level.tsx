// A choice among a few levels, as a row of icon buttons of which one is pressed, each named by its
// tooltip, at the inputs' height so every one lines up. Without a way to change it, it reads as its
// name; with a reason it is locked.

import type * as React from "react";

import { WithTooltip } from "@/web/components/with-tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/web/components/ui/toggle-group";

export interface Level<T extends string> {
  value: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function AccessLevel<T extends string>({
  levels,
  value,
  onChange,
  label,
  disabled,
  locked,
}: {
  levels: readonly Level<T>[];
  value: T;
  // Without it, the level is only shown.
  onChange?: (value: T) => void;
  // What the group is called to assistive tools.
  label: string;
  disabled?: boolean;
  // Why the reader, who may change others', may not change this one.
  locked?: string;
}) {
  if (!onChange) {
    return (
      <span className="text-sm text-muted-foreground">
        {levels.find((level) => level.value === value)?.label ?? value}
      </span>
    );
  }
  const group = (
    <ToggleGroup
      aria-label={label}
      variant="outline"
      spacing={0}
      value={[value]}
      disabled={disabled || !!locked}
      onValueChange={(next: string[]) => {
        // One stays pressed: pressing the pressed one again changes nothing.
        const found = levels.find((level) => level.value !== value && next.includes(level.value));
        if (found) onChange(found.value);
      }}
      className="shrink-0"
    >
      {levels.map(({ value: level, label: name, icon: Icon }) => (
        <WithTooltip key={level} label={name}>
          <ToggleGroupItem value={level} aria-label={name} className="size-8 px-0">
            <Icon />
          </ToggleGroupItem>
        </WithTooltip>
      ))}
    </ToggleGroup>
  );
  return locked ? (
    <WithTooltip label={locked}>
      {/* A disabled control takes no pointer, so its wrapper holds the tooltip. */}
      <span className="inline-flex" tabIndex={0}>
        {group}
      </span>
    </WithTooltip>
  ) : (
    group
  );
}
