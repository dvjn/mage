// The "Keyboard shortcuts" dialog: every shortcut in the registry by group, with its keys. It opens
// with ? outside a text field, or from the user menu.

import { createContext, type ReactNode, use, useCallback, useState } from "react";

import { ShortcutKeys } from "@/web/components/shortcut-keys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { shortcutsByGroup, useShortcut } from "@/web/lib/shortcuts";

const OpenHelpContext = createContext<(() => void) | null>(null);

// Opens the shortcuts dialog.
export function useOpenShortcutsHelp() {
  const open = use(OpenHelpContext);
  if (!open) throw new Error("the shortcuts dialog needs its provider");
  return open;
}

export function ShortcutsHelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  useShortcut("help", show);

  return (
    <OpenHelpContext value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Shortcuts with a letter alone do nothing while you type.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {shortcutsByGroup().map(({ group, shortcuts }) => (
              <section key={group} aria-label={group} className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{group}</h3>
                <ul className="flex flex-col">
                  {shortcuts.map((shortcut) => (
                    <li
                      key={shortcut.id}
                      className="flex min-h-8 items-center justify-between gap-4 text-sm"
                    >
                      <span>{shortcut.name}</span>
                      <ShortcutKeys id={shortcut.id} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </OpenHelpContext>
  );
}
