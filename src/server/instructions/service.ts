// The instructions orgs and spaces give the agent, read in its system prompt after Mage's own: an
// org's owners write the org's, which apply in every space, and its members read them; a space's
// managers write the space's, which follow the org's in its threads. They shape what the agent
// does but never what it may do: tool policies still decide every call.

import type { Principal } from "@/server/orgs/identity.ts";
import type { Space, Spaces } from "@/server/spaces/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Instructions as InstructionsBody, SpaceInstructions } from "@/shared/instructions.ts";

export interface InstructionRecord {
  text: string;
  updatedAt: Date;
}

export interface InstructionStore {
  // The org's own with no space given, or the space's.
  get(orgId: string, spaceId: string | null): InstructionRecord | null;
  set(orgId: string, spaceId: string | null, text: string, userId: string): void;
}

export interface InstructionsOptions {
  store: InstructionStore;
  spaces: Pick<Spaces, "require">;
}

export type Instructions = ReturnType<typeof createInstructions>;

const ORG_ONLY = "Only the organization's owners can change its instructions";

export function createInstructions({ store, spaces }: InstructionsOptions) {
  function read(orgId: string, spaceId: string | null): InstructionsBody {
    const record = store.get(orgId, spaceId);
    return { text: record?.text ?? "", updatedAt: record?.updatedAt.toISOString() ?? null };
  }

  return {
    // The org's and the space's, as the agent reads them in the space.
    textsFor(space: Pick<Space, "id" | "orgId">) {
      return { org: read(space.orgId, null).text, space: read(space.orgId, space.id).text };
    },

    inOrg(principal: Principal): InstructionsBody {
      return read(principal.orgId, null);
    },

    setInOrg(principal: Principal, text: string): InstructionsBody {
      if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
      store.set(principal.orgId, null, text.trim(), principal.userId);
      return read(principal.orgId, null);
    },

    inSpace(principal: Principal, spaceId: string): SpaceInstructions {
      const space = spaces.require(principal, spaceId);
      return { own: read(space.orgId, space.id), org: read(space.orgId, null) };
    },

    setInSpace(principal: Principal, spaceId: string, text: string): SpaceInstructions {
      const space = spaces.require(principal, spaceId, "manage");
      store.set(space.orgId, space.id, text.trim(), principal.userId);
      return { own: read(space.orgId, space.id), org: read(space.orgId, null) };
    },
  };
}
