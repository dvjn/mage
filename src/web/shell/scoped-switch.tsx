// The switch of something the org or a space has, with its words: On or Off for what the scope
// owns, nothing more for the org's in a space unless it is switched there (On here or Off here,
// with a lock), and Off by organization while the org has it off. One that cannot be changed may
// say why on hover.

import { LockIcon } from "lucide-react";

import { WithTooltip } from "@/web/components/with-tooltip";
import { Switch } from "@/web/components/ui/switch";

export function ScopedSwitch({
  label,
  inSpace,
  here = false,
  orgOff,
  checked,
  disabled,
  why,
  onCheckedChange,
}: {
  label: string;
  // The org's, as a space sees it.
  inSpace: boolean;
  // The space switches the org's for itself.
  here?: boolean;
  orgOff: boolean;
  checked: boolean;
  disabled: boolean;
  // Why it cannot be changed, shown on hover.
  why?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const words = orgOff
    ? "Off by organization"
    : inSpace
      ? here && (checked ? "On here" : "Off here")
      : checked
        ? "On"
        : "Off";
  const control = (
    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {inSpace && here && (
        <WithTooltip label="Managed by the organization">
          <LockIcon className="size-3.5" aria-hidden />
        </WithTooltip>
      )}
      {words}
      <Switch
        size="sm"
        aria-label={`${label}: ${inSpace ? "on in this space" : "on"}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
  return why ? <WithTooltip label={why}>{control}</WithTooltip> : control;
}
