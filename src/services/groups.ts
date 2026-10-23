// A team org's groups, as everyone in it sees them: a page at a time, one at a glance, and their
// members. Spaces give roles to groups as to people. Groups come from a directory; Mage keeps no
// way to make or change them by hand.

import type { Directory, GroupRow } from "@/ports/directory.ts";
import type { Principal } from "@/ports/identity.ts";
import { ServiceError } from "@/services/errors.ts";
import type { GroupMember, GroupSummary } from "@/shared/orgs.ts";
import type { Page, PageParams } from "@/shared/paging.ts";

export interface GroupsOptions {
  directory: Directory;
}

export type Groups = ReturnType<typeof createGroups>;

export function createGroups(options: GroupsOptions) {
  const { directory } = options;

  function requireGroup(principal: Principal, id: string) {
    const group = directory.group(id);
    if (!group || group.orgId !== principal.orgId) throw new ServiceError(404, "Group not found");
    return group;
  }

  function summaryOf(group: GroupRow): GroupSummary {
    return {
      id: group.id,
      name: group.name,
      source: group.source,
      memberCount: group.memberCount,
      createdAt: group.createdAt.toISOString(),
    };
  }

  return {
    // A page of the org's groups by name, with how many are in each.
    list(principal: Principal, params: PageParams): Page<GroupSummary> {
      const page = directory.groupPage(principal.orgId, params);
      return { ...page, items: page.items.map(summaryOf) };
    },

    get(principal: Principal, id: string) {
      const group = requireGroup(principal, id);
      return summaryOf({ ...group, memberCount: directory.memberCount(id) });
    },

    // A page of the group's members by name.
    members(principal: Principal, id: string, params: PageParams): Page<GroupMember> {
      requireGroup(principal, id);
      const page = directory.groupMemberPage(id, params);
      return {
        ...page,
        items: page.items.map((user) => ({ userId: user.id, name: user.name, email: user.email })),
      };
    },
  };
}
