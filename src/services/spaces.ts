// An org's spaces as its people see them: listing, creating, renaming and deleting empty ones,
// setting the model and effort their new threads start with, and the one rule for what each member
// may do in a space.

import type { Principal } from "@/ports/identity.ts";
import type { Space, SpaceRole, SpaceStore } from "@/ports/spaces.ts";
import type { ThreadStore } from "@/ports/threads.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Models } from "@/services/models.ts";
import type { Effort } from "@/shared/threads.ts";

export interface SpacesOptions {
  spaces: SpaceStore;
  threads: Pick<ThreadStore, "anyInSpace">;
  models: Pick<Models, "requireModel">;
}

export type Spaces = ReturnType<typeof createSpaces>;

// Reading the space's threads; posting, steering, queueing and stopping in them; managing the space.
export type SpaceAction = "read" | "message" | "manage";

const ALLOWED: Record<SpaceRole, readonly SpaceAction[]> = {
  owner: ["read", "message", "manage"],
  messager: ["read", "message"],
  viewer: ["read"],
};

const REFUSED: Record<SpaceAction, string> = {
  read: "Space not found",
  message: "Only the space's messagers and owners can do this",
  manage: "Only the space's owner can do this",
};

export function createSpaces(options: SpacesOptions) {
  const { spaces, threads, models } = options;

  // The principal's role in the space, or null when its org is not theirs or they are not a member.
  function roleIn(principal: Pick<Principal, "userId" | "orgId">, space: Space) {
    return space.orgId === principal.orgId ? spaces.roleOf(space.id, principal.userId) : null;
  }

  // The one rule for what a person may do in a space: their org owns it and their role there
  // allows the action.
  function can(principal: Pick<Principal, "userId" | "orgId">, space: Space, action: SpaceAction) {
    const role = roleIn(principal, space);
    return role !== null && ALLOWED[role].includes(action);
  }

  function canSee(principal: Principal, space: Space) {
    return can(principal, space, "read");
  }

  // The space with the principal's role when they can see it, otherwise null.
  function findVisible(
    principal: Pick<Principal, "userId" | "orgId">,
    id: string,
  ): (Space & { role: SpaceRole }) | null {
    const space = spaces.find(id);
    const role = space && roleIn(principal, space);
    return space && role ? { ...space, role } : null;
  }

  // The space when the principal may take the action there. A space they cannot see is not found,
  // so its existence does not leak; one they can see but not act on is forbidden.
  function require(principal: Principal, id: string, action: SpaceAction = "read") {
    const space = findVisible(principal, id);
    if (!space) throw new ServiceError(404, REFUSED.read);
    if (!can(principal, space, action)) throw new ServiceError(403, REFUSED[action]);
    return space;
  }

  return {
    can,
    canSee,
    findVisible,
    require,

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
      require(principal, id, "manage");
      return { ...spaces.rename(id, name), role: "owner" as const };
    },

    // A default model must be one the org can use now; null goes back to the org's.
    async setDefaults(
      principal: Principal,
      id: string,
      changes: { model?: string | null; effort?: Effort | null },
    ) {
      require(principal, id, "manage");
      if (changes.model) await models.requireModel(principal.orgId, changes.model);
      // Seen again after the model check, which waits on providers.
      require(principal, id, "manage");
      return { ...spaces.setDefaults(id, changes), role: "owner" as const };
    },

    remove(principal: Principal, id: string) {
      const space = require(principal, id, "manage");
      if (space.primary) throw new ServiceError(409, `${space.name} cannot be deleted`);
      if (threads.anyInSpace(id)) {
        throw new ServiceError(409, "Only a space without threads can be deleted");
      }
      spaces.delete(id);
    },
  };
}
