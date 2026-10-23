// The folders open in the sidebar while the app is open; each starts closed.

import { useCallback, useState } from "react";

export function useOpenFolders() {
  const [open, setOpen] = useState(() => new Set<string>());
  const setFolderOpen = useCallback((id: string, next: boolean) => {
    setOpen((current) => {
      if (current.has(id) === next) return current;
      const updated = new Set(current);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  }, []);
  return { open, setFolderOpen };
}
