// An org's spaces as its people see them: listing, creating, renaming and deleting empty ones,
// and the one rule for who can see a space.

import type { Principal } from "@/ports/identity.ts";
import type { Space, SpaceRole, SpaceStore } from "@/ports/spaces.ts";
import type { ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";

export interface SpacesOptions {
  spaces: SpaceStore;
  threads: Pick<ThreadStore, "anyInSpace">;
}

export type Spaces = ReturnType<typeof createSpaces>;

export function createSpaces(options: SpacesOptions) {
  const { spaces, threads } = options;

  // Whether the principal can see the space: their org owns it and they are a member.
  function canSee(principal: Principal, space: Space) {
    return space.orgId === principal.orgId && spaces.roleOf(space.id, principal.userId) !== null;
  }

  // The space with the principal's role when they can see it, otherwise null.
  function findVisible(principal: Principal, id: string): (Space & { role: SpaceRole }) | null {
    const space = spaces.find(id);
    if (!space || !canSee(principal, space)) return null;
    return { ...space, role: spaces.roleOf(id, principal.userId) ?? "member" };
  }

  // A space the principal cannot see is not found, so its existence does not leak.
  function visible(principal: Principal, id: string) {
    const space = findVisible(principal, id);
    if (!space) throw new ServiceError(404, "Space not found");
    return space;
  }

  function owned(principal: Principal, id: string) {
    const space = visible(principal, id);
    if (space.role !== "owner") throw new ServiceError(403, "Only the space's owner can do this");
    return space;
  }

  return {
    canSee,
    findVisible,
    visible,

    list(principal: Principal) {
      return spaces.listForMember(principal.orgId, principal.userId);
    },

    create(principal: Principal, name: string) {
      const space = spaces.create({
        orgId: principal.orgId,
        kind: "personal",
        name,
        createdBy: principal.userId,
      });
      return { ...space, role: "owner" as const };
    },

    rename(principal: Principal, id: string, name: string) {
      owned(principal, id);
      return { ...spaces.rename(id, name), role: "owner" as const };
    },

    remove(principal: Principal, id: string) {
      const space = owned(principal, id);
      if (space.primary) throw new ServiceError(409, `${space.name} cannot be deleted`);
      if (threads.anyInSpace(id)) {
        throw new ServiceError(409, "Only a space without threads can be deleted");
      }
      spaces.delete(id);
    },
  };
}
