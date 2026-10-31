// The organization's tools page: its access policies, every toolset the agent can use, built in or
// from an MCP server, each with its tools' policies, and an MCP server's own page. Only the org's
// owners change them.

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { SettingsTitle } from "@/web/shell/settings-page";
import { McpServerPage } from "@/web/mcp/servers/page";
import { McpServersCard } from "@/web/mcp/servers/card";
import { OrgToolsList } from "@/web/agent/tools-list";
import { meQuery } from "@/web/auth/queries";

const serverRoute = getRouteApi("/_app/org/tools/mcp/$serverId");

export function OrgTools() {
  const me = useQuery(meQuery);
  const canManage = me.data?.role === "owner";
  return (
    <>
      <SettingsTitle
        title="Tools and MCPs"
        description={
          canManage
            ? "What the agent can use in every space, and who has to approve it."
            : "What the agent can use in every space, and who has to approve it. Only the organization's owners change this."
        }
      />
      <OrgToolsList
        canManage={canManage}
        mcp={(toolsets) => (
          <McpServersCard scope={{ kind: "org" }} toolsets={toolsets} canManage={canManage} />
        )}
      />
    </>
  );
}

export function OrgMcpServer() {
  const { serverId } = serverRoute.useParams();
  return <McpServerPage scope={{ kind: "org" }} serverId={serverId} />;
}
