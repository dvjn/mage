// Spaces hold an org's threads; their members are who can see them.

export type SpaceRole = "owner" | "member";

export interface Space {
  id: string;
  orgId: string;
  kind: "personal" | "shared";
  name: string;
  // The space a personal org starts with; it can be renamed but not deleted.
  primary: boolean;
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
  rename(id: string, name: string): Space;
  delete(id: string): void;
}
