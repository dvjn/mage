// Who can open a thread or an artifact beyond the people given it: a radio list of the levels, each
// saying who it reaches. One the server does not offer is shown closed, and the chosen one can show
// a control of its own, such as what the org's members may do.

import type * as React from "react";
import type { ReactNode } from "react";

import { FieldLabel } from "@/web/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/web/components/ui/radio-group";

export interface AccessChoice<T extends string> {
  value: T;
  label: string;
  reach: string;
  icon: React.ComponentType<{ className?: string }>;
  // Set for a level the reader may not choose.
  closed?: boolean;
  // Shown under the level while it is the chosen one.
  control?: ReactNode;
}

export function GeneralAccess<T extends string>({
  label,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  choices: AccessChoice<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <section aria-label="General access" className="flex flex-col gap-2">
      <FieldLabel>General access</FieldLabel>
      <RadioGroup
        aria-label={label}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          const found = choices.find((choice) => choice.value === next);
          if (found && found.value !== value) onChange(found.value);
        }}
        className="gap-0 overflow-hidden rounded-lg border"
      >
        {choices.map(({ value: level, label: name, reach, icon: Icon, closed, control }) => (
          <div key={level} className="border-b last:border-b-0 has-data-checked:bg-muted/50">
            <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 has-data-disabled:cursor-not-allowed">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`text-sm font-medium ${closed ? "text-muted-foreground" : ""}`}>
                  {name}
                </span>
                <span className="text-xs text-muted-foreground">{reach}</span>
              </span>
              <RadioGroupItem
                value={level}
                aria-label={name}
                disabled={closed}
                className="mt-0.5"
              />
            </label>
            {level === value && control && <div className="px-3 pb-2.5 pl-10">{control}</div>}
          </div>
        ))}
      </RadioGroup>
    </section>
  );
}
