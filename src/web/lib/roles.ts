// How a space role is written in the app.

import type { SpaceSummary } from "@/shared/spaces.ts";

export const ROLE_LABELS: Record<SpaceSummary["role"], string> = {
  owner: "Owner",
  messager: "Messager",
  viewer: "Viewer",
};
