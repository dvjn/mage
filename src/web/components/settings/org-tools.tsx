// The organization's tools page: every toolset the agent can use, built in or from an MCP server,
// each with its tools' permissions, and an MCP server's own page. Only the org's owners change
// them.

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { SettingsTitle } from "@/web/components/settings/layout";
import { McpServerPage, McpServersCard } from "@/web/components/settings/mcp-servers";
import { OrgToolsList } from "@/web/components/settings/tools-list";
import { meQuery } from "@/web/lib/queries";

const serverRoute = getRouteApi("/_app/org/tools/mcp/$serverId");

export function OrgTools() {
  const me = useQuery(meQuery);
  const canManage = me.data?.role === "owner";
  return (
    <>
      <SettingsTitle
        title="Tools"
        description={
          canManage
            ? "The tools the agent can use, and whether each runs, asks first, or is off. Spaces can only make these stricter."
            : "The tools the agent can use, and whether each runs, asks first, or is off. Only the organization's owners change this."
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
