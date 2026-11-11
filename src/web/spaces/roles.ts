// How a space role is written in the app, and why one cannot be changed.

import type { SpaceRole } from "@/shared/spaces.ts";

export const ROLE_LABELS: Record<SpaceRole, string> = {
  owner: "Owner",
  messager: "Message",
  viewer: "View",
};

// Why the one looking may not change a role.
export const LOCK_REASONS = {
  org: {
    self: "You can't change your own role",
    last_owner: "An organization needs at least one owner",
  },
  space: {
    self: "You can't change your own role",
    last_owner: "A space needs at least one owner",
  },
} as const;
