// The row that adds people: the subject picker with what they get beside its box, an access level
// and, where access ends, for how long. A share sheet adds on pick; a dialog keeps what is picked
// below the box until its Add. Which of the two is the caller's: it adds in `onPick`, or keeps
// `picked`.

import type * as React from "react";

import type { AccessFor } from "@/shared/guests.ts";
import { AccessLength } from "@/web/sharing/access-length";
import { AccessLevel, type Level } from "@/web/components/access-level";
import { SubjectPicker } from "@/web/spaces/subject-picker";

type PickerProps = Omit<React.ComponentProps<typeof SubjectPicker>, "trailing">;

export function AddPeople<T extends string>({
  levels,
  level,
  onLevel,
  length,
  ...picker
}: PickerProps & {
  levels: readonly Level<T>[];
  level: T;
  onLevel: (level: T) => void;
  // How long access lasts, where it ends.
  length?: { value: AccessFor; onChange: (value: AccessFor) => void };
}) {
  return (
    <SubjectPicker
      {...picker}
      trailing={
        <>
          {length && (
            <AccessLength
              label="Access lasts for the person added"
              value={length.value}
              onChange={length.onChange}
            />
          )}
          <AccessLevel
            levels={levels}
            value={level}
            label="Access for the person added"
            onChange={onLevel}
          />
        </>
      }
    />
  );
}
