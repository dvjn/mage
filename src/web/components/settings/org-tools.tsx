// The organization's tools page: every toolset the agent can use, built in or (later) from an MCP
// server, each with its tools' permissions. Only the org's owners change them.

import { useQuery } from "@tanstack/react-query";

import { SettingsTitle } from "@/web/components/settings/layout";
import { OrgToolsList } from "@/web/components/settings/tools-list";
import { meQuery } from "@/web/lib/queries";

export function OrgTools() {
  const me = useQuery(meQuery);
  const canManage = me.data?.role === "owner";
  return (
    <>
      <SettingsTitle
        title="Tools"
        description={
          canManage
            ? "What the agent can do in this organization's threads. Anyone who can message runs an allowed tool; a tool that needs approval asks each time. Spaces can only make these stricter."
            : "What the agent can do in this organization's threads. Only the organization's owners can change this."
        }
      />
      <OrgToolsList canManage={canManage} />
    </>
  );
}
