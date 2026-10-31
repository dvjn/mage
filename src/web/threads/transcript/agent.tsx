// What the agent's rows share: its avatar, the caret it writes behind, and the name of the model a
// turn was written with.

import { useQuery } from "@tanstack/react-query";

import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { initialsOf } from "@/web/lib/initials";
import { modelsQuery } from "@/web/models/queries";

export const agentAvatar = (
  <Avatar size="sm">
    <AvatarFallback>{initialsOf("Agent")}</AvatarFallback>
  </Avatar>
);

// The blinking cursor the agent writes behind.
export const caret = (
  <span aria-hidden className="inline-block h-4 w-2 animate-pulse bg-foreground/70" />
);

// The model's name from the org's list, or the id its ref ends with.
export function useModelName(ref: string | null) {
  const models = useQuery(modelsQuery);
  if (!ref) return null;
  const listed = [...(models.data?.models ?? []), ...(models.data?.turnedOff ?? [])];
  return listed.find((model) => model.ref === ref)?.name ?? (ref.split("/").pop() || null);
}
