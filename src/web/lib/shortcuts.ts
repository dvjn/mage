// The app's keyboard shortcuts in one registry: each one's keys, name and group. Components bind a
// shortcut by its id, so no key string is written anywhere else, and the help dialog lists the
// registry. Keys the composer handles itself are listed for display only.

import {
  formatForDisplay,
  type Hotkey,
  type HotkeyCallback,
  useHotkey,
  type UseHotkeyOptions,
} from "@tanstack/react-hotkeys";

export type ShortcutGroup = "General" | "Threads" | "Composer";

export interface Shortcut {
  hotkey: Hotkey;
  name: string;
  group: ShortcutGroup;
  // Handled where it is typed, not bound through the registry.
  displayOnly?: boolean;
  // How a short hint writes it, where the keys pressed say more than needed.
  hint?: string;
}

export const SHORTCUTS = {
  search: { hotkey: "Mod+K", name: "Search threads", group: "General" },
  toggleSidebar: { hotkey: "Mod+B", name: "Show or hide the sidebar", group: "General" },
  help: { hotkey: "Shift+?", name: "Keyboard shortcuts", group: "General", hint: "?" },
  // Mod+O also keeps the browser from opening a file.
  newThread: { hotkey: "Mod+O", name: "New thread", group: "Threads" },
  send: { hotkey: "Enter", name: "Send, or steer the reply", group: "Composer", displayOnly: true },
  queue: {
    hotkey: "Alt+Enter",
    name: "Queue for the next reply",
    group: "Composer",
    displayOnly: true,
  },
  newline: { hotkey: "Shift+Enter", name: "New line", group: "Composer", displayOnly: true },
  close: { hotkey: "Escape", name: "Close a dialog or menu", group: "Composer", displayOnly: true },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

export const SHORTCUT_GROUPS: ShortcutGroup[] = ["General", "Threads", "Composer"];

// The registry's shortcuts by group, in the order they are listed.
export function shortcutsByGroup() {
  return SHORTCUT_GROUPS.map((group) => ({
    group,
    shortcuts: (Object.entries(SHORTCUTS) as [ShortcutId, Shortcut][])
      .filter(([, shortcut]) => shortcut.group === group)
      .map(([id, shortcut]) => ({ id, ...shortcut })),
  }));
}

// The keys of a shortcut, one label each, as the system in use writes them.
export function shortcutKeys(id: ShortcutId, platform?: "mac" | "windows" | "linux") {
  return formatForDisplay(SHORTCUTS[id].hotkey, { parts: true, ...(platform && { platform }) });
}

// The shortcut written as one short hint, as "⌘K" or "Ctrl+K".
export function shortcutHint(id: ShortcutId, platform?: "mac" | "windows" | "linux") {
  const shortcut: Shortcut = SHORTCUTS[id];
  return shortcut.hint ?? formatForDisplay(shortcut.hotkey, platform ? { platform } : {});
}

// Runs `handler` when the shortcut is pressed. Plain keys are ignored while typing; combinations
// with ⌘ or Ctrl work anywhere.
export function useShortcut(
  id: Exclude<ShortcutId, "send" | "queue" | "newline" | "close">,
  handler: HotkeyCallback,
  options: Omit<UseHotkeyOptions, "meta"> = {},
) {
  const { hotkey, name } = SHORTCUTS[id];
  useHotkey(hotkey, handler, { ...options, meta: { name } });
}
