// The folder picked in the sidebar, for each person and space, remembered in this browser and the
// same wherever the app asks for it; none picked shows the whole space.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

import { meQuery } from "@/web/lib/queries";

const listeners = new Set<() => void>();
// Picks made while storage is unavailable, which then last while the app is open.
const unsaved = new Map<string, string | null>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function read(key: string) {
  if (unsaved.has(key)) return unsaved.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, folderId: string | null) {
  try {
    if (folderId) localStorage.setItem(key, folderId);
    else localStorage.removeItem(key);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, folderId);
  }
  for (const listener of listeners) listener();
}

export function usePickedFolder(spaceId: string) {
  const me = useQuery(meQuery);
  const userId = me.data?.user.id;
  const key = userId ? `mage:folder:${userId}:${spaceId}` : null;
  const folderId = useSyncExternalStore(subscribe, () => (key ? read(key) : null));
  const pick = useCallback(
    (next: string | null) => {
      if (key) write(key, next);
    },
    [key],
  );
  return [folderId, pick] as const;
}
