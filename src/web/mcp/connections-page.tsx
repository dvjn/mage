// The signed-in person's account: the MCP servers whose calls run with each person's own
// credentials, where each is used, whether they connected and whether it still works, with
// connecting, reconnecting and disconnecting.

import { useQuery } from "@tanstack/react-query";

import type { McpConnection } from "@/shared/mcp.ts";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/web/components/ui/item";
import { ConnectButton } from "@/web/mcp/connect";
import { useDisconnect } from "@/web/mcp/mutations";
import { mcpConnectionsQuery } from "@/web/mcp/queries";
import { SettingsCard, SettingsPage } from "@/web/shell/settings-page";
import { spacesQuery } from "@/web/spaces/queries";

function ConnectionBadge({ status }: { status: McpConnection["status"] }) {
  if (status === "ok") return <Badge variant="secondary">Connected</Badge>;
  if (status === "needs_auth") {
    return (
      <Badge variant="outline" className="border-tool-ask/40 text-tool-ask">
        Needs reconnecting
      </Badge>
    );
  }
  return <Badge variant="outline">Not connected</Badge>;
}

export function AccountPage() {
  const connections = useQuery(mcpConnectionsQuery);
  const spaces = useQuery(spacesQuery);
  const disconnect = useDisconnect();

  function usedIn(connection: McpConnection) {
    if (!connection.spaceId) return "Organization";
    return spaces.data?.find((space) => space.id === connection.spaceId)?.name ?? "A space";
  }

  return (
    <SettingsPage crumbs={[{ label: "Account" }]} title="Account">
      <SettingsCard
        title="MCP connections"
        description="Servers that run your calls with your own credentials."
        state={connections}
      >
        {connections.data?.length ? (
          <div className="flex flex-col gap-2">
            {connections.data.map((connection) => (
              <Item
                key={connection.serverId}
                variant="outline"
                size="sm"
                render={<section aria-label={connection.serverName} />}
              >
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    {connection.serverName}
                    <ConnectionBadge status={connection.status} />
                  </ItemTitle>
                  <ItemDescription>{usedIn(connection)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {connection.status !== "ok" && (
                    <ConnectButton
                      size="sm"
                      label={connection.status ? "Reconnect" : "Connect"}
                      connection={{ ...connection, title: connection.serverName }}
                    />
                  )}
                  {connection.status && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate(connection.serverId)}
                    >
                      Disconnect
                    </Button>
                  )}
                </ItemActions>
              </Item>
            ))}
            {disconnect.error && (
              <p role="alert" className="text-sm text-destructive">
                {disconnect.error.message}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">None</p>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
