// Which toolsets, servers and repositories the person has open in settings, remembered in this
// browser for them.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { meQuery } from "@/web/auth/queries";

// Which toolsets the person has open, kept in this browser; a toolset never toggled is closed.
export function useOpenSections(scope: "org" | "space") {
  const userId = useQuery(meQuery).data?.user.id ?? "";
  const key = `mage:tool-sections:${userId}:${scope}`;
  const [kept, setKept] = useState(() => ({ key, open: storedSections(key) }));
  // The person is known only once the app has read who they are; read their sections then.
  if (kept.key !== key) setKept({ key, open: storedSections(key) });
  const open = kept.key === key ? kept.open : storedSections(key);
  return {
    isOpen: (id: string) => open[id] ?? false,
    set(id: string, next: boolean) {
      const all = { ...open, [id]: next };
      setKept({ key, open: all });
      try {
        localStorage.setItem(key, JSON.stringify(all));
      } catch {
        // Storage can be unavailable; the toolsets then start closed.
      }
    },
  };
}

function storedSections(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
