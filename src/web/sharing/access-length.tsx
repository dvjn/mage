// How long access lasts, as a select at the inputs' height.

import { type AccessFor, accessForSchema } from "@/shared/guests.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";

export const ACCESS_LABELS: Record<AccessFor, string> = {
  "1h": "1 hour",
  "1d": "1 day",
  "7d": "7 days",
  never: "No expiry",
};

export function AccessLength({
  id,
  label,
  value,
  onChange,
  grow,
}: {
  id?: string;
  label: string;
  value: AccessFor;
  onChange: (value: AccessFor) => void;
  grow?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const parsed = accessForSchema.safeParse(next);
        if (parsed.success) onChange(parsed.data);
      }}
    >
      <SelectTrigger id={id} aria-label={label} className={grow ? "flex-1" : "w-28 shrink-0"}>
        <SelectValue>{(shown: AccessFor) => ACCESS_LABELS[shown]}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {accessForSchema.options.map((option) => (
          <SelectItem key={option} value={option}>
            {ACCESS_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
