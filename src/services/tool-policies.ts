// The access policies orgs and spaces keep for their tools: listing them with the people and
// groups they name and how many tools use them, and making, changing, copying and deleting them.
// The org's owners keep the org's, which every space may use; those who manage a space keep its
// own. A policy still in use can't be deleted.

import type { Directory } from "@/ports/directory.ts";
import type { Principal } from "@/ports/identity.ts";
import type { Space, SpaceStore } from "@/ports/spaces.ts";
import type {
  ToolPolicyFields,
  ToolPolicyRecord,
  ToolPolicyStore,
  ToolSettingStore,
} from "@/ports/tools.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Spaces } from "@/services/spaces.ts";
import type { Tools } from "@/services/tools.ts";
import {
  EDITORS,
  identityKind,
  type PolicyIdentity,
  type ToolPolicy,
  type ToolPolicyInput,
} from "@/shared/tools.ts";

export interface ToolPoliciesOptions {
  policies: ToolPolicyStore;
  settings: Pick<ToolSettingStore, "policyUses">;
  tools: Pick<Tools, "find">;
  spaceStore: Pick<SpaceStore, "find">;
  spaces: Pick<Spaces, "require">;
  directory: Pick<Directory, "user" | "group" | "linkedRole" | "memberCount">;
}

export type ToolPolicies = ReturnType<typeof createToolPolicies>;

const OWNERS_ONLY = "Only the organization's owners can do this";

// Whose policies: the org's, or one space's.
type Scope = { orgId: string; spaceId: string | null };

export function createToolPolicies(options: ToolPoliciesOptions) {
  const { policies, settings, tools, spaceStore, spaces, directory } = options;

  // How many tools each policy is set on, in the org and its spaces, counting only tools that
  // are still there.
  function counts(orgId: string) {
    const found = new Map<string, Space | null>();
    const spaceOf = (id: string) => {
      if (!found.has(id)) found.set(id, spaceStore.find(id));
      return found.get(id)!;
    };
    const result = new Map<string, number>();
    for (const use of settings.policyUses(orgId)) {
      const space = use.spaceId ? spaceOf(use.spaceId) : null;
      if (use.spaceId && !space) continue;
      if (!tools.find(orgId, use.toolId, space ?? undefined)) continue;
      result.set(use.policyId, (result.get(use.policyId) ?? 0) + 1);
    }
    return result;
  }

  // A key as a policy shows it: who it is, or that they are gone.
  function identityOf(orgId: string, key: string): PolicyIdentity {
    const kind = identityKind(key);
    if (kind === "editors") {
      return { key, kind, name: "Anyone who can edit the thread", detail: null, stale: false };
    }
    const id = key.slice(key.indexOf(":") + 1);
    if (kind === "group") {
      const group = directory.group(id);
      const linked = group && directory.linkedRole(orgId, id);
      if (!group || !linked) {
        return { key, kind, name: group?.name ?? "Removed group", detail: null, stale: true };
      }
      const count = directory.memberCount(id);
      return {
        key,
        kind,
        name: group.name,
        detail: `Group · ${count} ${count === 1 ? "person" : "people"}`,
        stale: false,
      };
    }
    const user = directory.user(id);
    if (!user) return { key, kind, name: "Removed person", detail: null, stale: true };
    return { key, kind, name: user.name, detail: user.email, stale: false };
  }

  function viewOf(policy: ToolPolicyRecord, used: Map<string, number>): ToolPolicy {
    return {
      id: policy.id,
      spaceId: policy.spaceId,
      name: policy.name,
      color: policy.color,
      use: policy.use,
      users: policy.users.map((key) => identityOf(policy.orgId, key)),
      approvers: policy.approvers.map((key) => identityOf(policy.orgId, key)),
      independent: policy.independent,
      toolCount: used.get(policy.id) ?? 0,
    };
  }

  // The policy as kept: who uses it only when asked, who approves only when not everyone uses it,
  // each named once, and only people and groups the org has.
  function fieldsOf(orgId: string, input: ToolPolicyInput): ToolPolicyFields {
    const unique = (keys: string[]) => [...new Set(keys)];
    const fields: ToolPolicyFields = {
      name: input.name.trim(),
      color: input.color,
      use: input.use,
      users: input.use === "some" ? unique(input.users) : [],
      approvers: input.use === "everyone" ? [] : unique(input.approvers),
      independent: input.use !== "everyone" && input.independent,
    };
    for (const key of [...fields.users, ...fields.approvers]) {
      if (key === EDITORS) continue;
      if (identityOf(orgId, key).stale) {
        throw new ServiceError(400, "Pick people and groups of the organization");
      }
    }
    return fields;
  }

  function listOf(scope: Scope, include: (policy: ToolPolicyRecord) => boolean) {
    const used = counts(scope.orgId);
    return policies
      .inOrg(scope.orgId)
      .filter(include)
      .map((policy) => viewOf(policy, used));
  }

  // The scope's own policy by its id.
  function own(scope: Scope, id: string) {
    const policy = policies.find(id);
    if (!policy || policy.orgId !== scope.orgId || policy.spaceId !== scope.spaceId) {
      throw new ServiceError(404, "Policy not found");
    }
    return policy;
  }

  function create(scope: Scope, input: ToolPolicyInput) {
    const policy = policies.create({ ...scope, ...fieldsOf(scope.orgId, input) });
    return viewOf(policy, new Map());
  }

  function update(scope: Scope, id: string, input: ToolPolicyInput) {
    own(scope, id);
    policies.update(id, fieldsOf(scope.orgId, input));
    return viewOf(policies.find(id)!, counts(scope.orgId));
  }

  function remove(scope: Scope, id: string) {
    own(scope, id);
    if ((counts(scope.orgId).get(id) ?? 0) > 0) {
      throw new ServiceError(409, "Move its tools to another policy first");
    }
    policies.delete(id);
  }

  function orgScope(principal: Principal, change: boolean): Scope {
    if (change && principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
    return { orgId: principal.orgId, spaceId: null };
  }

  function spaceScope(principal: Principal, spaceId: string): Scope {
    const space = spaces.require(principal, spaceId, "manage");
    return { orgId: space.orgId, spaceId: space.id };
  }

  return {
    // The org's policies, for anyone in it.
    inOrg(principal: Principal): ToolPolicy[] {
      return listOf(orgScope(principal, false), (policy) => policy.spaceId === null);
    },
    createInOrg(principal: Principal, input: ToolPolicyInput) {
      return create(orgScope(principal, true), input);
    },
    updateInOrg(principal: Principal, id: string, input: ToolPolicyInput) {
      return update(orgScope(principal, true), id, input);
    },
    deleteInOrg(principal: Principal, id: string) {
      remove(orgScope(principal, true), id);
    },

    // The policies a space can use: its own, and the org's.
    inSpace(principal: Principal, spaceId: string): ToolPolicy[] {
      const scope = spaceScope(principal, spaceId);
      return listOf(scope, (policy) => policy.spaceId === null || policy.spaceId === scope.spaceId);
    },
    createInSpace(principal: Principal, spaceId: string, input: ToolPolicyInput) {
      return create(spaceScope(principal, spaceId), input);
    },
    updateInSpace(principal: Principal, spaceId: string, id: string, input: ToolPolicyInput) {
      return update(spaceScope(principal, spaceId), id, input);
    },
    deleteInSpace(principal: Principal, spaceId: string, id: string) {
      remove(spaceScope(principal, spaceId), id);
    },
  };
}
