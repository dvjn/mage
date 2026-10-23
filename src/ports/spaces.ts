// Spaces hold an org's threads; their members are who can see them.

import type { Effort } from "@/shared/threads.ts";

// Owners manage the space; messagers and owners post; viewers only read.
export type SpaceRole = "owner" | "messager" | "viewer";

export interface Space {
  id: string;
  orgId: string;
  kind: "personal" | "shared";
  name: string;
  // The space a personal org starts with; it can be renamed but not deleted.
  primary: boolean;
  // The model ref and reasoning effort its new threads start with; null takes the org's.
  defaultModel: string | null;
  defaultEffort: Effort | null;
  // Null once the user who made it is gone.
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewSpace {
  orgId: string;
  kind: Space["kind"];
  name: string;
  primary?: boolean;
  createdBy: string;
}

export interface SpaceStore {
  // Makes the space with its creator as owner.
  create(space: NewSpace): Space;
  find(id: string): Space | null;
  // The org's spaces the user is a member of, with their role: the primary one, then oldest first.
  listForMember(orgId: string, userId: string): (Space & { role: SpaceRole })[];
  // The user's role in the space, or null when they are not a member.
  roleOf(spaceId: string, userId: string): SpaceRole | null;
  // The org's spaces whose default model is one of the refs.
  withDefaultModel(orgId: string, refs: string[]): Space[];
  rename(id: string, name: string): Space;
  // Null goes back to the org's; a field left out is kept.
  setDefaults(id: string, changes: { model?: string | null; effort?: Effort | null }): Space;
  delete(id: string): void;
}
