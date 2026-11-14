// The access policies orgs and spaces keep for their tools: listing them with the people and
// groups they name and how many tools use them, and making, changing, copying and deleting them.
// The org's owners keep the org's, which every space may use; those who manage a space keep its
// own. A policy still in use can't be deleted.

import type { Directory } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import {
  EDITORS,
  identityKind,
  type PolicyIdentity,
  type ToolPolicy,
  type ToolPolicyInput,
} from "@/shared/tools.ts";

import type {
  ToolPolicyFields,
  ToolPolicyRecord,
  ToolPolicyStore,
  ToolSettingStore,
  Tools,
} from "./tools.ts";

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
  async function counts(orgId: string) {
    const found = new Map<string, Space | null>();
    const spaceOf = async (id: string) => {
      if (!found.has(id)) found.set(id, await spaceStore.find(id));
      return found.get(id)!;
    };
    const result = new Map<string, number>();
    for (const use of await settings.policyUses(orgId)) {
      const space = use.spaceId ? await spaceOf(use.spaceId) : null;
      if (use.spaceId && !space) continue;
      if (!(await tools.find(orgId, use.toolId, space ?? undefined))) continue;
      result.set(use.policyId, (result.get(use.policyId) ?? 0) + 1);
    }
    return result;
  }

  // A key as a policy shows it: who it is, or that they are gone.
  async function identityOf(orgId: string, key: string): Promise<PolicyIdentity> {
    const kind = identityKind(key);
    if (kind === "editors") {
      return { key, kind, name: "Anyone who can edit the thread", detail: null, stale: false };
    }
    const id = key.slice(key.indexOf(":") + 1);
    if (kind === "group") {
      const group = await directory.group(id);
      const linked = group && (await directory.linkedRole(orgId, id));
      if (!group || !linked) {
        return { key, kind, name: group?.name ?? "Removed group", detail: null, stale: true };
      }
      return {
        key,
        kind,
        name: group.name,
        detail: null,
        memberCount: await directory.memberCount(id),
        stale: false,
      };
    }
    const user = await directory.user(id);
    if (!user) return { key, kind, name: "Removed person", detail: null, stale: true };
    return { key, kind, name: user.name, detail: user.email, stale: false };
  }

  async function viewOf(policy: ToolPolicyRecord, used: Map<string, number>): Promise<ToolPolicy> {
    return {
      id: policy.id,
      spaceId: policy.spaceId,
      name: policy.name,
      color: policy.color,
      use: policy.use,
      users: await Promise.all(policy.users.map(async (key) => identityOf(policy.orgId, key))),
      approvers: await Promise.all(
        policy.approvers.map(async (key) => identityOf(policy.orgId, key)),
      ),
      independent: policy.independent,
      toolCount: used.get(policy.id) ?? 0,
    };
  }

  // The policy as kept: who uses it only when asked, who approves only when not everyone uses it,
  // each named once, and only people and groups the org has.
  async function fieldsOf(orgId: string, input: ToolPolicyInput): Promise<ToolPolicyFields> {
    const unique = (keys: string[]) => [...new Set(keys)];
    const fields: ToolPolicyFields = {
      name: input.name.trim(),
      color: input.color,
      use: input.use,
      users: input.use === "some" ? unique(input.users) : [],
      approvers: input.use === "everyone" ? [] : unique(input.approvers),
      independent: input.use === "none" && input.independent,
    };
    for (const key of [...fields.users, ...fields.approvers]) {
      if (key === EDITORS) continue;
      if ((await identityOf(orgId, key)).stale) {
        throw new ServiceError(400, "Pick people and groups of the organization");
      }
    }
    return fields;
  }

  async function listOf(scope: Scope, include: (policy: ToolPolicyRecord) => boolean) {
    const used = await counts(scope.orgId);
    return await Promise.all(
      (await policies.inOrg(scope.orgId))
        .filter(include)
        .map(async (policy) => viewOf(policy, used)),
    );
  }

  // The scope's own policy by its id.
  async function own(scope: Scope, id: string) {
    const policy = await policies.find(id);
    if (!policy || policy.orgId !== scope.orgId || policy.spaceId !== scope.spaceId) {
      throw new ServiceError(404, "Policy not found");
    }
    return policy;
  }

  async function create(scope: Scope, input: ToolPolicyInput) {
    const policy = await policies.create({ ...scope, ...(await fieldsOf(scope.orgId, input)) });
    return viewOf(policy, new Map());
  }

  async function update(scope: Scope, id: string, input: ToolPolicyInput) {
    await own(scope, id);
    await policies.update(id, await fieldsOf(scope.orgId, input));
    return viewOf((await policies.find(id))!, await counts(scope.orgId));
  }

  async function remove(scope: Scope, id: string) {
    await own(scope, id);
    if (((await counts(scope.orgId)).get(id) ?? 0) > 0) {
      throw new ServiceError(409, "Move its tools to another policy first");
    }
    await policies.delete(id);
  }

  function orgScope(principal: Principal, change: boolean): Scope {
    if (change && principal.role !== "owner") throw new ServiceError(403, OWNERS_ONLY);
    return { orgId: principal.orgId, spaceId: null };
  }

  async function spaceScope(principal: Principal, spaceId: string): Promise<Scope> {
    const space = await spaces.require(principal, spaceId, "manage");
    return { orgId: space.orgId, spaceId: space.id };
  }

  return {
    // The org's policies, for anyone in it.
    async inOrg(principal: Principal): Promise<ToolPolicy[]> {
      return listOf(orgScope(principal, false), (policy) => policy.spaceId === null);
    },
    async createInOrg(principal: Principal, input: ToolPolicyInput) {
      return create(orgScope(principal, true), input);
    },
    async updateInOrg(principal: Principal, id: string, input: ToolPolicyInput) {
      return update(orgScope(principal, true), id, input);
    },
    async deleteInOrg(principal: Principal, id: string) {
      await remove(orgScope(principal, true), id);
    },

    // The policies a space can use: its own, and the org's.
    async inSpace(principal: Principal, spaceId: string): Promise<ToolPolicy[]> {
      const scope = await spaceScope(principal, spaceId);
      return listOf(scope, (policy) => policy.spaceId === null || policy.spaceId === scope.spaceId);
    },
    async createInSpace(principal: Principal, spaceId: string, input: ToolPolicyInput) {
      return create(await spaceScope(principal, spaceId), input);
    },
    async updateInSpace(principal: Principal, spaceId: string, id: string, input: ToolPolicyInput) {
      return update(await spaceScope(principal, spaceId), id, input);
    },
    async deleteInSpace(principal: Principal, spaceId: string, id: string) {
      await remove(await spaceScope(principal, spaceId), id);
    },
  };
}
