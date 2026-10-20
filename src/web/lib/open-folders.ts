// The folders open in the sidebar, kept in this browser across reloads.

import { useCallback, useState } from "react";

const KEY = "mage:open-folders";

function read(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be unavailable; folders then start closed on the next load.
  }
}

export function useOpenFolders() {
  const [open, setOpen] = useState(() => new Set(read()));
  const setFolderOpen = useCallback((id: string, next: boolean) => {
    setOpen((current) => {
      if (current.has(id) === next) return current;
      const updated = new Set(current);
      if (next) updated.add(id);
      else updated.delete(id);
      write(updated);
      return updated;
    });
  }, []);
  return { open, setFolderOpen };
}
