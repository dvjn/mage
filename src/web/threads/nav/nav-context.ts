// What the sidebar's thread rows read of the space they are listed in, and what its menus ask for.

import { createContext, use } from "react";

import type { FolderSummary } from "@/shared/folders.ts";
import type { SpaceSummary } from "@/shared/spaces.ts";
import type { ThreadSummary } from "@/shared/threads/thread.ts";
import type { FolderAction } from "@/web/folders/folder-dialogs";
import type { ThreadAction } from "@/web/threads/thread-dialogs";

// What the sidebar's folder and thread menus ask for.
export type NavAction = FolderAction | ThreadAction;

export interface Nav {
  activeThreadId: string | undefined;
  act: (action: NavAction) => void;
  folders: FolderSummary[];
  spaceId: string;
  // Moves a thread to a folder or out of one; a failure is told in a toast.
  move: (thread: ThreadSummary, folderId: string | null) => void;
  role: SpaceSummary["role"];
}

export const NavContext = createContext<Nav | null>(null);

export function useNav() {
  const nav = use(NavContext);
  if (!nav) throw new Error("items need the nav context");
  return nav;
}
