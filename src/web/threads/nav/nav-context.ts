// What the sidebar's thread rows read of the space they are listed in, and what its menus ask for.

import { createContext, use } from "react";

import type { SpaceSummary } from "@/shared/spaces.ts";
import type { ThreadAction } from "@/web/threads/thread-dialogs";

// What the sidebar's thread menus ask for.
export type NavAction = ThreadAction;

export interface Nav {
  activeThreadId: string | undefined;
  act: (action: NavAction) => void;
  role: SpaceSummary["role"];
}

export const NavContext = createContext<Nav | null>(null);

export function useNav() {
  const nav = use(NavContext);
  if (!nav) throw new Error("items need the nav context");
  return nav;
}
