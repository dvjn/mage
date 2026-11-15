import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/server/schema.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { EDITORS, TOOL_OFF } from "@/shared/tools.ts";

describe("tool settings", () => {
  it("are kept for an org and for a space apart, one row for each tool in each", async () => {
    const { toolSettings, db, ada, space } = await agentThread();
    const orgId = ada.orgId;

    await toolSettings.setInOrg(orgId, ["thread.rename", "thread.info"], TOOL_OFF);
    await toolSettings.setInSpace(space.id, ["thread.rename"], TOOL_OFF);
    await toolSettings.setToolsetInOrg(orgId, "thread", false);
    await toolSettings.setToolsetInOrg(orgId, "thread", true);
    await toolSettings.setToolsetInSpace(space.id, "thread", true);
    await toolSettings.setToolsetInSpace(space.id, "thread", false);
    await toolSettings.setOptionInOrg(orgId, "subagents", "choose_models", false);
    await toolSettings.setOptionInOrg(orgId, "subagents", "choose_models", true);
    await toolSettings.setOptionInSpace(space.id, "subagents", "choose_models", false);

    expect(await toolSettings.inOrg(orgId)).toEqual(
      new Map([
        ["thread.rename", TOOL_OFF],
        ["thread.info", TOOL_OFF],
      ]),
    );
    expect(await toolSettings.inSpace(space.id)).toEqual(new Map([["thread.rename", TOOL_OFF]]));
    expect(await toolSettings.toolsetsInOrg(orgId)).toEqual(new Map([["thread", true]]));
    expect(await toolSettings.toolsetsInSpace(space.id)).toEqual(new Map([["thread", false]]));
    expect((await toolSettings.optionsInOrg(orgId)).get("subagents")).toEqual(
      new Map([["choose_models", true]]),
    );
    expect((await toolSettings.optionsInSpace(space.id)).get("subagents")).toEqual(
      new Map([["choose_models", false]]),
    );
    // A space's row names its org too.
    expect(await db.select().from(schema.toolsetSetting)).toEqual([
      { organizationId: orgId, spaceId: null, toolsetId: "thread", enabled: true },
      { organizationId: orgId, spaceId: space.id, toolsetId: "thread", enabled: false },
    ]);

    // Taking a setting back leaves the other scope's.
    await toolSettings.setInOrg(orgId, ["thread.rename"], null);
    expect([...(await toolSettings.inOrg(orgId)).keys()]).toEqual(["thread.info"]);
    expect([...(await toolSettings.inSpace(space.id)).keys()]).toEqual(["thread.rename"]);
  });

  it("go with the policy they name, and a space's with the space", async () => {
    const { toolSettings, toolPolicyStore, db, ada, space } = await agentThread();
    const orgId = ada.orgId;
    const policy = await toolPolicyStore.create({
      orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    await toolSettings.setInOrg(orgId, ["thread.rename"], policy.id);
    await toolSettings.setInOrg(orgId, ["thread.info"], TOOL_OFF);
    await toolSettings.setInSpace(space.id, ["thread.rename"], policy.id);
    await toolSettings.setInSpace(space.id, ["thread.info"], TOOL_OFF);
    expect(await toolSettings.policyUses(orgId)).toEqual([
      { spaceId: null, toolId: "thread.rename", policyId: policy.id },
      { spaceId: space.id, toolId: "thread.rename", policyId: policy.id },
    ]);

    await toolPolicyStore.delete(policy.id);
    expect(await toolSettings.policyUses(orgId)).toEqual([]);
    expect([...(await toolSettings.inOrg(orgId)).keys()]).toEqual(["thread.info"]);
    expect([...(await toolSettings.inSpace(space.id)).keys()]).toEqual(["thread.info"]);

    await db.delete(schema.space).where(eq(schema.space.id, space.id));
    expect(await db.select().from(schema.toolSetting)).toEqual([
      { organizationId: orgId, spaceId: null, toolId: "thread.info", policyId: null },
    ]);
  });
});
