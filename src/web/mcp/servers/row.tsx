// One MCP server as a collapsible row: how it answered, its tools' policies, a switch that turns it
// on or off (a server's own for those who manage it, or for the org's in a space whether the space
// uses it, which stays off while the org has the server off) and a link to its page; inside, its
// tools with their policy pickers.

import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { type McpServerSummary } from "@/shared/mcp.ts";
import type { ToolsetSetting } from "@/shared/tools.ts";
import { PolicyCounts } from "@/web/agent/policies/tags";
import { ToolsetTools } from "@/web/agent/toolset-tools";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { MoreMenu } from "@/web/components/more-menu";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import type { Scope } from "@/web/shell/scope";
import { useRemoveServer, useServerSwitch } from "@/web/mcp/mutations";
import { ScopedSwitch } from "@/web/shell/scoped-switch";
import { RowBadge, SettingsRow } from "@/web/shell/settings-row";
import { plural } from "@/web/lib/plural";
import type { Row } from "@/web/mcp/servers/card";

// A server's page, by its scope.
export function pageLink(scope: Scope, serverId: string) {
  return scope.kind === "org"
    ? ({ to: "/org/tools/mcp/$serverId", params: { serverId } } as const)
    : ({
        to: "/s/$spaceId/settings/tools/mcp/$serverId",
        params: { spaceId: scope.spaceId, serverId },
      } as const);
}

// How the server answered when last reached, in a word or two.
export function statusOf(server: McpServerSummary): {
  label: string;
  tone: "ok" | "ask" | "error";
} {
  if (server.status === "error") return { label: "Can't connect", tone: "error" };
  if (server.status === "needs_auth") {
    const never = server.auth.kind === "oauth" && !server.auth.authorized && !server.toolsReadAt;
    return {
      label: never ? "Not connected" : "Needs reconnecting",
      tone: "ask",
    };
  }
  return { label: "Connected", tone: "ok" };
}

export function StatusBadge({ server }: { server: McpServerSummary }) {
  const { label, tone } = statusOf(server);
  return <RowBadge tone={tone}>{label}</RowBadge>;
}

export function ServerRow({
  scope,
  row,
  canManage,
  open,
  onOpenChange,
  toolset,
}: {
  scope: Scope;
  row: Row;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolset: ToolsetSetting | undefined;
}) {
  const { server } = row;
  const { error, pending, setEnabled, setInSpace } = useServerSwitch(scope);
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const removal = useRemoveServer();
  const link = pageLink(scope, server.id);
  // The org's server as a space sees it: off there while the org has it off.
  const orgOff = row.kind === "org" && !server.enabled;
  const on = row.kind === "org" ? row.server.enabled && row.server.inSpace : server.enabled;
  const inSpace = row.kind === "org" && scope.kind === "space";
  const ok = server.status === "ok";
  const tools = toolset?.tools ?? [];
  return (
    <SettingsRow
      title={server.name}
      badge={scope.kind === "space" && row.kind === "own" && <RowBadge>This space</RowBadge>}
      meta={
        ok ? (
          <>
            {plural(server.toolCount, "tool")}
            <PolicyCounts tools={tools} />
          </>
        ) : (
          <StatusBadge server={server} />
        )
      }
      open={open}
      onOpenChange={onOpenChange}
      on={on}
      control={
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {error && (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          )}
          <ScopedSwitch
            label={server.name}
            inSpace={inSpace}
            orgOff={orgOff}
            checked={on}
            disabled={orgOff || (row.kind === "own" && !canManage) || pending}
            onCheckedChange={(next) =>
              row.kind === "org" ? setInSpace(server, next) : setEnabled(server, next)
            }
          />
          <MoreMenu
            row
            name={server.name}
            destructive={
              row.kind === "own" &&
              canManage && (
                <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
                  <Trash2Icon />
                  Remove
                </DropdownMenuItem>
              )
            }
          >
            <DropdownMenuItem onClick={() => void navigate(link)}>
              <SettingsIcon />
              Settings
            </DropdownMenuItem>
          </MoreMenu>
        </span>
      }
    >
      {tools.length > 0 ? (
        <ToolsetTools toolset={toolset!} scope={scope.kind} />
      ) : (
        <p className="py-2 text-sm text-muted-foreground">
          {orgOff
            ? "Turned off by the organization."
            : server.toolsReadAt
              ? "The server lists no tools."
              : "Its tools show once the server answers."}
        </p>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => {
          setRemoving(open);
          if (!open) removal.reset();
        }}
        title={`Remove ${server.name}?`}
        description="The agent stops using its tools, and Mage forgets how it connects."
        error={removal.error?.message}
        disabled={removal.isPending}
        action="Remove"
        onConfirm={() => removal.mutate(server.id, { onSuccess: () => setRemoving(false) })}
      />
    </SettingsRow>
  );
}
