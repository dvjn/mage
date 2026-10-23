// A shortcut's keys from the registry, each in its own key cap, as the system in use writes them,
// or as one short hint.

import { cn } from "cn";

import { Kbd, KbdGroup } from "@/web/components/ui/kbd";
import { shortcutHint, shortcutKeys, type ShortcutId } from "@/web/lib/shortcuts";

export function ShortcutKeys({ id, className }: { id: ShortcutId; className?: string }) {
  return (
    <KbdGroup className={className}>
      {shortcutKeys(id).map((key, index) => (
        <Kbd key={index}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
}

// A shortcut as one quiet key cap, shown on its row's hover or focus, or while ⌘ or Ctrl is held
// over the sidebar.
export function ShortcutHint({ id, className }: { id: ShortcutId; className?: string }) {
  return (
    <Kbd
      className={cn(
        "ml-auto opacity-0 transition-opacity group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 in-data-[hints=shown]:opacity-100",
        className,
      )}
    >
      {shortcutHint(id)}
    </Kbd>
  );
}
