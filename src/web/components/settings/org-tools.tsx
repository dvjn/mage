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
            ? "The tools the agent can use, and whether each runs, asks first, or is off. Spaces can only make these stricter."
            : "The tools the agent can use, and whether each runs, asks first, or is off. Only the organization's owners change this."
        }
      />
      <OrgToolsList canManage={canManage} />
    </>
  );
}
