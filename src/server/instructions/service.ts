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
  get(orgId: string, spaceId: string | null): Promise<InstructionRecord | null>;
  set(orgId: string, spaceId: string | null, text: string, userId: string): Promise<void>;
}

export interface InstructionsOptions {
  store: InstructionStore;
  spaces: Pick<Spaces, "require">;
}

export type Instructions = ReturnType<typeof createInstructions>;

const ORG_ONLY = "Only the organization's owners can change its instructions";

export function createInstructions({ store, spaces }: InstructionsOptions) {
  async function read(orgId: string, spaceId: string | null): Promise<InstructionsBody> {
    const record = await store.get(orgId, spaceId);
    return { text: record?.text ?? "", updatedAt: record?.updatedAt.toISOString() ?? null };
  }

  return {
    // The org's and the space's, as the agent reads them in the space.
    async textsFor(space: Pick<Space, "id" | "orgId">) {
      return {
        org: (await read(space.orgId, null)).text,
        space: (await read(space.orgId, space.id)).text,
      };
    },

    async inOrg(principal: Principal): Promise<InstructionsBody> {
      return read(principal.orgId, null);
    },

    async setInOrg(principal: Principal, text: string): Promise<InstructionsBody> {
      if (principal.role !== "owner") throw new ServiceError(403, ORG_ONLY);
      await store.set(principal.orgId, null, text.trim(), principal.userId);
      return read(principal.orgId, null);
    },

    async inSpace(principal: Principal, spaceId: string): Promise<SpaceInstructions> {
      const space = await spaces.require(principal, spaceId);
      return { own: await read(space.orgId, space.id), org: await read(space.orgId, null) };
    },

    async setInSpace(
      principal: Principal,
      spaceId: string,
      text: string,
    ): Promise<SpaceInstructions> {
      const space = await spaces.require(principal, spaceId, "manage");
      await store.set(space.orgId, space.id, text.trim(), principal.userId);
      return { own: await read(space.orgId, space.id), org: await read(space.orgId, null) };
    },
  };
}
