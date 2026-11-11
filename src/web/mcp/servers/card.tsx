// The MCP servers card in settings: the org's servers, or for a space the org's beside its own
// tagged as such, each a row; and the org's switch for whether spaces add their own.

import { EmptyState } from "@/web/components/page-states";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { type McpServerSummary, mcpToolsetId, type SpaceOrgMcpServer } from "@/shared/mcp.ts";
import type { ToolsetSetting } from "@/shared/tools.ts";
import { SettingsCard } from "@/web/shell/settings-page";
import { useOpenSections } from "@/web/agent/open-sections";
import { Alert, AlertDescription } from "@/web/components/ui/alert";
import { HeaderAction } from "@/web/shell/people-table";
import { orgMcpServersQuery, spaceMcpServersQuery } from "@/web/mcp/queries";
import type { Scope } from "@/web/shell/scope";
import { SettingsSwitch } from "@/web/shell/settings-switch";
import { ServerRow } from "@/web/mcp/servers/row";
import { McpServerDialog } from "@/web/mcp/servers/server-dialog";
import { useSpaceServersAllowed } from "@/web/mcp/mutations";

export function McpServersCard({
  scope,
  toolsets,
  canManage,
}: {
  scope: Scope;
  toolsets: ToolsetSetting[];
  canManage: boolean;
}) {
  return scope.kind === "org" ? (
    <OrgServersCard toolsets={toolsets} canManage={canManage} />
  ) : (
    <SpaceServersCard spaceId={scope.spaceId} toolsets={toolsets} />
  );
}

// A row of the table: one of the org's servers, or one the scope's own.
export type Row =
  | { kind: "org"; server: SpaceOrgMcpServer }
  | { kind: "own"; server: McpServerSummary };

function OrgServersCard({
  toolsets,
  canManage,
}: {
  toolsets: ToolsetSetting[];
  canManage: boolean;
}) {
  const servers = useQuery(orgMcpServersQuery);
  return (
    <ServersCard
      scope={{ kind: "org" }}
      state={servers}
      rows={(servers.data?.servers ?? []).map((server) => ({
        kind: "own",
        server,
      }))}
      allowed
      spaceServers={servers.data?.spaceServers ?? null}
      toolsets={toolsets}
      canManage={canManage}
    />
  );
}

function SpaceServersCard({ spaceId, toolsets }: { spaceId: string; toolsets: ToolsetSetting[] }) {
  const servers = useQuery(spaceMcpServersQuery(spaceId));
  return (
    <ServersCard
      scope={{ kind: "space", spaceId }}
      state={servers}
      rows={[
        ...(servers.data?.org ?? []).map((server): Row => ({
          kind: "org",
          server,
        })),
        ...(servers.data?.own ?? []).map((server): Row => ({
          kind: "own",
          server,
        })),
      ]}
      allowed={servers.data?.allowed ?? true}
      spaceServers={null}
      toolsets={toolsets}
      canManage
    />
  );
}

function ServersCard({
  scope,
  state,
  rows,
  allowed,
  spaceServers,
  toolsets,
  canManage,
}: {
  scope: Scope;
  state: { isPending: boolean; error: Error | null };
  rows: Row[];
  // Whether the scope may add servers and the agent uses them: a space's only while the org lets
  // spaces have them.
  allowed: boolean;
  // For the org, whether its spaces may add their own.
  spaceServers: boolean | null;
  toolsets: ToolsetSetting[];
  canManage: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const sections = useOpenSections(scope.kind);
  const ownRows = rows.some((row) => row.kind === "own");
  return (
    <SettingsCard
      title="MCP servers"
      description={
        scope.kind === "org"
          ? "Servers whose tools the agent can use in every space."
          : "Servers whose tools the agent can use in this space: the organization's, and this space's own."
      }
      action={
        canManage && (
          <HeaderAction
            icon={<PlusIcon />}
            label="Add server"
            disabled={!allowed}
            onClick={() => setAdding(true)}
          />
        )
      }
      state={state}
    >
      <div className="flex flex-col gap-4">
        {!allowed && ownRows && (
          <Alert>
            <CircleAlertIcon />
            <AlertDescription>
              The organization does not let spaces add MCP servers, so the agent does not use this
              space's own.
            </AlertDescription>
          </Alert>
        )}
        {rows.length > 0 ? (
          <div className="-my-3 flex flex-col divide-y">
            {rows.map((row) => (
              <ServerRow
                key={row.server.id}
                scope={scope}
                row={row}
                canManage={canManage}
                open={sections.isOpen(mcpToolsetId(row.server.id))}
                onOpenChange={(open) => sections.set(mcpToolsetId(row.server.id), open)}
                toolset={toolsets.find((toolset) => toolset.id === mcpToolsetId(row.server.id))}
              />
            ))}
          </div>
        ) : (
          <EmptyState compact title="No servers yet" />
        )}
        {spaceServers !== null && (
          <SpaceServersSwitch allowed={spaceServers} canManage={canManage} />
        )}
      </div>
      <McpServerDialog scope={scope} open={adding} onOpenChange={setAdding} />
    </SettingsCard>
  );
}

function SpaceServersSwitch({ allowed, canManage }: { allowed: boolean; canManage: boolean }) {
  const allow = useSpaceServersAllowed();
  return (
    <SettingsSwitch
      label="Spaces can add their own"
      description="Those who manage a space add servers only its threads use."
      checked={allowed}
      disabled={!canManage || allow.isPending}
      error={allow.error?.message}
      className="border-t pt-4"
      onChange={(next) => allow.mutate(next)}
    />
  );
}
