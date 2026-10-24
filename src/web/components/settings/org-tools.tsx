// The organization's tools page: every toolset the agent can use, built in or (later) from an MCP
// server, each with its tools' permissions. Only the org's owners change them.

import { useQuery } from "@tanstack/react-query";

import { SettingsTitle } from "@/web/components/settings/layout";
import { OrgToolsCard } from "@/web/components/settings/tools-card";
import { meQuery } from "@/web/lib/queries";

export function OrgTools() {
  const me = useQuery(meQuery);
  return (
    <>
      <SettingsTitle
        title="Tools"
        description="What the agent can do in this organization's threads, by the toolset its tools come from."
      />
      <OrgToolsCard canManage={me.data?.role === "owner"} />
    </>
  );
}
