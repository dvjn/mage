// Starting a new thread, from the sidebar or a shortcut.

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

// Opens a new thread's draft in the space; the thread is made when its first message is sent.
export function useNewThread() {
  const navigate = useNavigate();
  return useCallback(
    (spaceId: string) => void navigate({ to: "/s/$spaceId/new", params: { spaceId } }),
    [navigate],
  );
}
