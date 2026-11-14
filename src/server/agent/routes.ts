import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody, checkedBody } from "@/server/http.ts";
import { toolAnswerSchema } from "@/shared/ask.ts";
import { toolDecisionSchema } from "@/shared/threads/requests.ts";
import {
  toolPolicyChangeSchema,
  toolPolicyInputSchema,
  toolsetEnabledChangeSchema,
} from "@/shared/tools.ts";

import type { ToolPolicies } from "./tool-policies.ts";
import type { ToolDecisions } from "./tools.ts";

const toolDecision = jsonBody(toolDecisionSchema, "allow is required; scope is once or for_now");

const toolAnswer = jsonBody(toolAnswerSchema, "answers are required, or null to skip");

const toolPolicyChange = jsonBody(
  toolPolicyChangeSchema,
  "Give toolIds and a policy: a policy's id, off, or null",
);

const toolPolicyInput = checkedBody(toolPolicyInputSchema);

const toolsetEnabledChange = jsonBody(toolsetEnabledChangeSchema, "enabled is true or false");

export function toolRoutes(options: { tools: ToolDecisions; toolPolicies: ToolPolicies }) {
  const { tools, toolPolicies } = options;
  return new Hono<ApiEnv>()
    .post("/v1/threads/:id/tools/:callId/decision", toolDecision, async (c) => {
      const { id, callId } = c.req.param();
      const decision = c.req.valid("json");
      await tools.decide(signedIn(c.var.principal), id, callId, decision);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/tools/:callId/background", async (c) => {
      const { id, callId } = c.req.param();
      await tools.moveToBackground(signedIn(c.var.principal), id, callId);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/tools/:callId/cancel", async (c) => {
      const { id, callId } = c.req.param();
      await tools.cancelBackground(signedIn(c.var.principal), id, callId);
      return c.json({ ok: true }, 200);
    })
    .post("/v1/threads/:id/tools/:callId/answer", toolAnswer, async (c) => {
      const { id, callId } = c.req.param();
      await tools.answer(signedIn(c.var.principal), id, callId, c.req.valid("json").answers);
      return c.json({ ok: true }, 200);
    })
    .get("/v1/org/tools", async (c) => {
      return c.json(await tools.orgTools(signedIn(c.var.principal)), 200);
    })
    .patch("/v1/org/tools", toolPolicyChange, async (c) => {
      const principal = signedIn(c.var.principal);
      await tools.setOrgTools(principal, c.req.valid("json"));
      return c.json(await tools.orgTools(principal), 200);
    })
    .get("/v1/spaces/:id/tools", async (c) => {
      return c.json(await tools.spaceTools(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .patch("/v1/spaces/:id/tools", toolPolicyChange, async (c) => {
      const principal = signedIn(c.var.principal);
      await tools.setSpaceTools(principal, c.req.param("id"), c.req.valid("json"));
      return c.json(await tools.spaceTools(principal, c.req.param("id")), 200);
    })
    .get("/v1/org/tool-policies", async (c) => {
      return c.json(await toolPolicies.inOrg(signedIn(c.var.principal)), 200);
    })
    .post("/v1/org/tool-policies", toolPolicyInput, async (c) => {
      return c.json(
        await toolPolicies.createInOrg(signedIn(c.var.principal), c.req.valid("json")),
        201,
      );
    })
    .put("/v1/org/tool-policies/:policyId", toolPolicyInput, async (c) => {
      const principal = signedIn(c.var.principal);
      return c.json(
        await toolPolicies.updateInOrg(principal, c.req.param("policyId"), c.req.valid("json")),
        200,
      );
    })
    .delete("/v1/org/tool-policies/:policyId", async (c) => {
      await toolPolicies.deleteInOrg(signedIn(c.var.principal), c.req.param("policyId"));
      return c.json({ ok: true }, 200);
    })
    .get("/v1/spaces/:id/tool-policies", async (c) => {
      return c.json(await toolPolicies.inSpace(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .post("/v1/spaces/:id/tool-policies", toolPolicyInput, async (c) => {
      const principal = signedIn(c.var.principal);
      return c.json(
        await toolPolicies.createInSpace(principal, c.req.param("id"), c.req.valid("json")),
        201,
      );
    })
    .put("/v1/spaces/:id/tool-policies/:policyId", toolPolicyInput, async (c) => {
      const { id, policyId } = c.req.param();
      const principal = signedIn(c.var.principal);
      return c.json(
        await toolPolicies.updateInSpace(principal, id, policyId, c.req.valid("json")),
        200,
      );
    })
    .delete("/v1/spaces/:id/tool-policies/:policyId", async (c) => {
      const { id, policyId } = c.req.param();
      await toolPolicies.deleteInSpace(signedIn(c.var.principal), id, policyId);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/org/toolsets/:toolsetId", toolsetEnabledChange, async (c) => {
      const principal = signedIn(c.var.principal);
      await tools.setOrgToolset(principal, c.req.param("toolsetId"), c.req.valid("json").enabled);
      return c.json(await tools.orgTools(principal), 200);
    })
    .put("/v1/spaces/:id/toolsets/:toolsetId", toolsetEnabledChange, async (c) => {
      const principal = signedIn(c.var.principal);
      await tools.setSpaceToolset(
        principal,
        c.req.param("id"),
        c.req.param("toolsetId"),
        c.req.valid("json").enabled,
      );
      return c.json(await tools.spaceTools(principal, c.req.param("id")), 200);
    })
    .put("/v1/org/toolsets/:toolsetId/options/:option", toolsetEnabledChange, async (c) => {
      const principal = signedIn(c.var.principal);
      const { toolsetId, option } = c.req.param();
      await tools.setOrgToolsetOption(principal, toolsetId, option, c.req.valid("json").enabled);
      return c.json(await tools.orgTools(principal), 200);
    })
    .put("/v1/spaces/:id/toolsets/:toolsetId/options/:option", toolsetEnabledChange, async (c) => {
      const principal = signedIn(c.var.principal);
      const { id, toolsetId, option } = c.req.param();
      await tools.setSpaceToolsetOption(
        principal,
        id,
        toolsetId,
        option,
        c.req.valid("json").enabled,
      );
      return c.json(await tools.spaceTools(principal, id), 200);
    });
}
