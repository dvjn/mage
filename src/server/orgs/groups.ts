// A team org's linked groups, as everyone in it sees them: a page at a time, one at a glance, and
// their members. Spaces give roles to groups as to people. Groups come from the directory; Mage
// keeps no way to make or change them by hand.

import { ServiceError } from "@/server/kernel/errors.ts";
import type { GroupMember, GroupSummary } from "@/shared/orgs.ts";
import type { Page, PageParams } from "@/shared/paging.ts";

import type { Directory, LinkedGroupRow } from "./directory.ts";
import type { Principal } from "./identity.ts";

export interface GroupsOptions {
  directory: Directory;
}

export type Groups = ReturnType<typeof createGroups>;

export function createGroups(options: GroupsOptions) {
  const { directory } = options;

  async function requireGroup(principal: Principal, id: string) {
    const group = await directory.group(id);
    const role = await directory.linkedRole(principal.orgId, id);
    if (!group || !role) throw new ServiceError(404, "Group not found");
    return { ...group, role, linkedAt: group.createdAt };
  }

  function summaryOf(group: LinkedGroupRow): GroupSummary {
    return {
      id: group.id,
      name: group.name,
      email: group.email,
      source: group.source,
      role: group.role,
      memberCount: group.memberCount,
      createdAt: group.createdAt.toISOString(),
    };
  }

  return {
    // A page of the org's groups by name, with how many are in each.
    async list(principal: Principal, params: PageParams): Promise<Page<GroupSummary>> {
      const page = await directory.groupPage(principal.orgId, params);
      return { ...page, items: page.items.map(summaryOf) };
    },

    async get(principal: Principal, id: string) {
      const group = await requireGroup(principal, id);
      return summaryOf({ ...group, memberCount: await directory.memberCount(id) });
    },

    // A page of the group's members by name.
    async members(
      principal: Principal,
      id: string,
      params: PageParams,
    ): Promise<Page<GroupMember>> {
      await requireGroup(principal, id);
      const page = await directory.groupMemberPage(id, params);
      return {
        ...page,
        items: page.items.map((user) => ({ userId: user.id, name: user.name, email: user.email })),
      };
    },
  };
}
