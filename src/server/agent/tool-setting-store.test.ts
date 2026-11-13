import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/server/schema.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { EDITORS, TOOL_OFF } from "@/shared/tools.ts";

describe("tool settings", () => {
  it("are kept for an org and for a space apart, one row for each tool in each", async () => {
    const { toolSettings, db, ada, space } = await agentThread();
    const orgId = ada.orgId;

    toolSettings.setInOrg(orgId, ["thread.rename", "thread.info"], TOOL_OFF);
    toolSettings.setInSpace(space.id, ["thread.rename"], TOOL_OFF);
    toolSettings.setToolsetInOrg(orgId, "thread", false);
    toolSettings.setToolsetInOrg(orgId, "thread", true);
    toolSettings.setToolsetInSpace(space.id, "thread", true);
    toolSettings.setToolsetInSpace(space.id, "thread", false);
    toolSettings.setOptionInOrg(orgId, "subagents", "choose_models", false);
    toolSettings.setOptionInOrg(orgId, "subagents", "choose_models", true);
    toolSettings.setOptionInSpace(space.id, "subagents", "choose_models", false);

    expect(toolSettings.inOrg(orgId)).toEqual(
      new Map([
        ["thread.rename", TOOL_OFF],
        ["thread.info", TOOL_OFF],
      ]),
    );
    expect(toolSettings.inSpace(space.id)).toEqual(new Map([["thread.rename", TOOL_OFF]]));
    expect(toolSettings.toolsetsInOrg(orgId)).toEqual(new Map([["thread", true]]));
    expect(toolSettings.toolsetsInSpace(space.id)).toEqual(new Map([["thread", false]]));
    expect(toolSettings.optionsInOrg(orgId).get("subagents")).toEqual(
      new Map([["choose_models", true]]),
    );
    expect(toolSettings.optionsInSpace(space.id).get("subagents")).toEqual(
      new Map([["choose_models", false]]),
    );
    // A space's row names its org too.
    expect(db.select().from(schema.toolsetSetting).all()).toEqual([
      { organizationId: orgId, spaceId: null, toolsetId: "thread", enabled: true },
      { organizationId: orgId, spaceId: space.id, toolsetId: "thread", enabled: false },
    ]);

    // Taking a setting back leaves the other scope's.
    toolSettings.setInOrg(orgId, ["thread.rename"], null);
    expect([...toolSettings.inOrg(orgId).keys()]).toEqual(["thread.info"]);
    expect([...toolSettings.inSpace(space.id).keys()]).toEqual(["thread.rename"]);
  });

  it("go with the policy they name, and a space's with the space", async () => {
    const { toolSettings, toolPolicyStore, db, ada, space } = await agentThread();
    const orgId = ada.orgId;
    const policy = toolPolicyStore.create({
      orgId,
      spaceId: null,
      name: "Sign-off",
      color: "orange",
      use: "none",
      users: [],
      approvers: [EDITORS],
      independent: false,
    });
    toolSettings.setInOrg(orgId, ["thread.rename"], policy.id);
    toolSettings.setInOrg(orgId, ["thread.info"], TOOL_OFF);
    toolSettings.setInSpace(space.id, ["thread.rename"], policy.id);
    toolSettings.setInSpace(space.id, ["thread.info"], TOOL_OFF);
    expect(toolSettings.policyUses(orgId)).toEqual([
      { spaceId: null, toolId: "thread.rename", policyId: policy.id },
      { spaceId: space.id, toolId: "thread.rename", policyId: policy.id },
    ]);

    toolPolicyStore.delete(policy.id);
    expect(toolSettings.policyUses(orgId)).toEqual([]);
    expect([...toolSettings.inOrg(orgId).keys()]).toEqual(["thread.info"]);
    expect([...toolSettings.inSpace(space.id).keys()]).toEqual(["thread.info"]);

    db.delete(schema.space).where(eq(schema.space.id, space.id)).run();
    expect(db.select().from(schema.toolSetting).all()).toEqual([
      { organizationId: orgId, spaceId: null, toolId: "thread.info", policyId: null },
    ]);
  });
});
