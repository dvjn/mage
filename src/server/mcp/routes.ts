import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody, checkedBody } from "@/server/http.ts";
import type { Identity } from "@/server/orgs/identity.ts";
import {
  mcpConnectAuthorizeSchema,
  mcpConnectHeadersSchema,
  mcpEnabledChangeSchema,
  mcpServerChangeSchema,
  type McpServerSummary,
  newMcpServerSchema,
  spaceServersChangeSchema,
} from "@/shared/mcp.ts";

import type { McpServers } from "./service.ts";

const newMcpServer = checkedBody(newMcpServerSchema);

const mcpServerChange = checkedBody(mcpServerChangeSchema);

const spaceServersChange = jsonBody(spaceServersChangeSchema, "allowed is true or false");

const mcpEnabledChange = jsonBody(mcpEnabledChangeSchema, "enabled is true or false");

const connectHeaders = checkedBody(mcpConnectHeadersSchema);

const connectAuthorize = checkedBody(mcpConnectAuthorizeSchema);

// Where the browser goes back to once an authorization finishes: the server's page.
function mcpServerPage(server: Pick<McpServerSummary, "id" | "spaceId"> | null) {
  if (!server) return "/org/tools";
  return server.spaceId
    ? `/s/${server.spaceId}/settings/tools/mcp/${server.id}`
    : `/org/tools/mcp/${server.id}`;
}

export function mcpRoutes(options: { identity: Identity; mcp: McpServers }) {
  const { identity, mcp } = options;
  return (
    new Hono<ApiEnv>()
      // Where an MCP server's authorization server sends the browser back, for whoever began it.
      .get("/mcp/oauth/callback", async (c) => {
        const account = await identity.resolve(c.req.raw.headers, null);
        const { state, code, iss, error } = c.req.query();
        const { server, returnTo } = await mcp.finishAuthorization(account?.userId ?? null, {
          state,
          code,
          iss,
          error,
        });
        return c.redirect(returnTo ?? mcpServerPage(server), 302);
      })
      .get("/v1/mcp-connections", (c) => {
        return c.json(mcp.connections(signedIn(c.var.principal)), 200);
      })
      .put("/v1/mcp-servers/:id/connection", connectHeaders, async (c) => {
        const principal = signedIn(c.var.principal);
        await mcp.connectHeaders(principal, c.req.param("id"), c.req.valid("json"));
        return c.json({ ok: true }, 200);
      })
      .post("/v1/mcp-servers/:id/connection/authorize", connectAuthorize, async (c) => {
        const principal = signedIn(c.var.principal);
        const { returnTo } = c.req.valid("json");
        return c.json(await mcp.connectOAuth(principal, c.req.param("id"), returnTo), 200);
      })
      .delete("/v1/mcp-servers/:id/connection", (c) => {
        mcp.disconnect(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/org/mcp-servers", (c) => {
        return c.json(mcp.orgServers(signedIn(c.var.principal)), 200);
      })
      .post("/v1/org/mcp-servers", newMcpServer, async (c) => {
        return c.json(await mcp.addToOrg(signedIn(c.var.principal), c.req.valid("json")), 200);
      })
      .put("/v1/org/mcp-servers/space-servers", spaceServersChange, (c) => {
        const principal = signedIn(c.var.principal);
        mcp.setSpaceServers(principal, c.req.valid("json").allowed);
        return c.json(mcp.orgServers(principal), 200);
      })
      .get("/v1/spaces/:id/mcp-servers", (c) => {
        return c.json(mcp.spaceServers(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .post("/v1/spaces/:id/mcp-servers", newMcpServer, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await mcp.addToSpace(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      .put("/v1/spaces/:id/mcp-servers/:serverId", mcpEnabledChange, (c) => {
        const principal = signedIn(c.var.principal);
        const { id, serverId } = c.req.param();
        mcp.setInSpace(principal, id, serverId, c.req.valid("json").enabled);
        return c.json(mcp.spaceServers(principal, id), 200);
      })
      .get("/v1/mcp-servers/:id", (c) => {
        return c.json(mcp.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .patch("/v1/mcp-servers/:id", mcpServerChange, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await mcp.change(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      .put("/v1/mcp-servers/:id/enabled", mcpEnabledChange, (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(
          mcp.setEnabled(principal, c.req.param("id"), c.req.valid("json").enabled),
          200,
        );
      })
      .post("/v1/mcp-servers/:id/refresh", async (c) => {
        return c.json(await mcp.refresh(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .post("/v1/mcp-servers/:id/authorize", async (c) => {
        return c.json(await mcp.authorize(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .delete("/v1/mcp-servers/:id", (c) => {
        mcp.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
  );
}
