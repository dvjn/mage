// An MCP server's page: its switch, its connection, its tools and their policies, reading them
// again, reconnecting, changing it in the form it was added with, and removing it. One of the
// org's servers opened from a space shows there with the space's switch and the space's extra
// rules for its tools, the rest of it the org's to manage.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { type McpServerSummary, mcpToolsetId } from "@/shared/mcp.ts";
import { LoadError } from "@/web/components/page-states";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { PolicyChangeError, ToolPoliciesProvider } from "@/web/agent/policies/provider";
import { toolsQuery } from "@/web/agent/queries";
import { ToolsetTools } from "@/web/agent/toolset-tools";
import { Time } from "@/web/components/time";
import { Alert, AlertDescription, AlertTitle } from "@/web/components/ui/alert";
import { Button } from "@/web/components/ui/button";
import { FieldError } from "@/web/components/ui/field";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Switch } from "@/web/components/ui/switch";
import { meQuery } from "@/web/auth/queries";
import { mcpServerQuery, spaceMcpServersQuery } from "@/web/mcp/queries";
import type { Scope } from "@/web/shell/scope";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { StatusBadge, statusOf } from "@/web/mcp/servers/row";
import { useServerSwitch } from "@/web/mcp/mutations";
import { McpServerDialog } from "@/web/mcp/servers/server-dialog";
import { useAuthorizeServer, useRefreshServer, useRemoveServer } from "@/web/mcp/mutations";

const TRANSPORTS: Record<NonNullable<McpServerSummary["transport"]>, string> = {
  "streamable-http": "Streamable HTTP",
  sse: "HTTP+SSE (older)",
};

function hostOf(url: string) {
  return URL.parse(url)?.host ?? url;
}

// One fact about the connection: its name, and what it is.
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
      <dt className="w-32 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function AuthFact({ server }: { server: McpServerSummary }) {
  const { auth } = server;
  switch (auth.kind) {
    case "none":
      return "None";
    case "headers":
      return (
        <ul className="flex flex-col gap-0.5">
          {auth.headers.map((header) => (
            <li key={header.name} className="font-mono text-xs">
              {header.name}: <span className="text-muted-foreground">{header.hint}</span>
            </li>
          ))}
        </ul>
      );
    case "oauth":
      return (
        <span className="flex flex-col gap-0.5">
          <span>
            OAuth
            {auth.issuer && <span className="text-muted-foreground"> · {hostOf(auth.issuer)}</span>}
          </span>
          {auth.clientId && (
            <span className="text-xs text-muted-foreground">
              {auth.registration === "manual"
                ? "Client entered"
                : "Client registered by the server"}
              : <span className="font-mono">{auth.clientId}</span>
            </span>
          )}
        </span>
      );
  }
}

export function McpServerPage({ scope, serverId }: { scope: Scope; serverId: string }) {
  const server = useQuery(mcpServerQuery(serverId));
  if (server.error) {
    return (
      <>
        <BackToTools scope={scope} />
        <LoadError />
      </>
    );
  }
  if (!server.data) {
    return (
      <>
        <BackToTools scope={scope} />
        <div aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      </>
    );
  }
  return <ServerDetail scope={scope} server={server.data} />;
}

function BackToTools({ scope }: { scope: Scope }) {
  return (
    <Link
      {...(scope.kind === "org"
        ? { to: "/org/tools" as const }
        : {
            to: "/s/$spaceId/settings/tools" as const,
            params: { spaceId: scope.spaceId },
          })}
      className="-mb-4 flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      Tools
    </Link>
  );
}

function ServerDetail({ scope, server }: { scope: Scope; server: McpServerSummary }) {
  const tools = useQuery(toolsQuery(scope));
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  // One of the org's servers, seen from a space: the space says whether it uses it, and adds extra
  // rules to its tools; the rest is the org's.
  const orgsInSpace = scope.kind === "space" && server.spaceId === null;
  const inSpace = useQuery({
    ...spaceMcpServersQuery(scope.kind === "space" ? scope.spaceId : ""),
    enabled: orgsInSpace,
    select: (data) => data.org.find((found) => found.id === server.id)?.inSpace,
  });
  const onHere = server.enabled && (!orgsInSpace || inSpace.data === true);
  // A space's servers reach this page only for those who manage the space.
  const canManage = orgsInSpace ? false : scope.kind === "space" || me.data?.role === "owner";
  const [editing, setEditing] = useState(false);
  const refreshing = useRefreshServer();
  const signingIn = useAuthorizeServer();
  const removal = useRemoveServer();
  const busy = refreshing.isPending
    ? "Reading tools…"
    : signingIn.isPending
      ? "Opening sign-in…"
      : undefined;
  const error = (refreshing.error ?? signingIn.error ?? removal.error)?.message;
  const toolset = tools.data?.find((found) => found.id === mcpToolsetId(server.id));
  const oauth = server.auth.kind === "oauth";
  const status = statusOf(server);
  const power = useServerSwitch(scope);

  // One action at a time says what went wrong.
  function only(action: { reset: () => void }) {
    for (const other of [refreshing, signingIn, removal]) if (other !== action) other.reset();
  }

  function refresh() {
    only(refreshing);
    refreshing.mutate(server.id);
  }

  function reconnect() {
    only(signingIn);
    signingIn.mutate(server.id);
  }

  function remove() {
    only(removal);
    removal.mutate(server.id, {
      onSuccess: () =>
        navigate(
          scope.kind === "org"
            ? { to: "/org/tools" }
            : { to: "/s/$spaceId/settings/tools", params: { spaceId: scope.spaceId } },
        ),
    });
  }

  const connect = oauth && (
    <Button size="sm" disabled={!!busy} onClick={reconnect}>
      {server.auth.kind === "oauth" && server.auth.authorized ? "Reconnect" : "Connect"}
    </Button>
  );

  return (
    <>
      <BackToTools scope={scope} />
      <SettingsTitle
        title={server.name}
        description={<span className="break-all">{server.url}</span>}
        action={
          orgsInSpace ? (
            <label className="flex shrink-0 items-center gap-2 text-sm">
              {onHere ? "On" : "Off"}
              <Switch
                aria-label="On in this space"
                checked={onHere}
                disabled={
                  !server.enabled || inSpace.data === undefined || !!inSpace.error || power.pending
                }
                onCheckedChange={(next) => power.setInSpace(server, next)}
              />
            </label>
          ) : (
            canManage && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <label className="mr-2 flex items-center gap-2 text-sm">
                  {server.enabled ? "On" : "Off"}
                  <Switch
                    aria-label="On"
                    checked={server.enabled}
                    disabled={power.pending}
                    onCheckedChange={(next) => power.setEnabled(server, next)}
                  />
                </label>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="outline" size="sm" disabled={!!busy} onClick={refresh}>
                  <RefreshCwIcon
                    className={busy === "Reading tools…" ? "animate-spin" : undefined}
                  />
                  Refresh tools
                </Button>
                {connect}
              </div>
            )
          )
        }
      />
      {orgsInSpace && inSpace.error && <FieldError>{inSpace.error.message}</FieldError>}
      {orgsInSpace && (
        <p className="text-sm text-muted-foreground">
          Managed by the organization: its connection and its tools' policies are set
          {me.data?.role === "owner" ? (
            <>
              {" "}
              in{" "}
              <Link
                to="/org/tools/mcp/$serverId"
                params={{ serverId: server.id }}
                className="underline underline-offset-4 hover:text-foreground"
              >
                the organization's settings
              </Link>
              .
            </>
          ) : (
            " by its owners."
          )}
        </p>
      )}
      {!server.enabled ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>{orgsInSpace ? "Turned off by the organization" : "Off"}</AlertTitle>
          <AlertDescription>
            {orgsInSpace
              ? "The agent does not use its tools in any space until the organization turns it on."
              : "The agent does not use its tools anywhere until it is turned on. Its connection and tool settings are kept."}
          </AlertDescription>
        </Alert>
      ) : (
        orgsInSpace &&
        inSpace.data === false && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Off in this space</AlertTitle>
            <AlertDescription>
              The agent does not use its tools here until it is turned on for this space.
            </AlertDescription>
          </Alert>
        )
      )}
      {server.status !== "ok" && (
        <Alert variant={status.tone === "error" ? "destructive" : "default"}>
          <CircleAlertIcon />
          <AlertTitle>{status.label}</AlertTitle>
          <AlertDescription>
            {server.error ??
              (oauth ? "Sign in with the server to let the agent use its tools." : "")}
            {server.status === "needs_auth" && server.error && canManage && oauth && (
              <span> Reconnect to sign in with the server again.</span>
            )}
            {server.status === "error" && server.auth.kind === "headers" && canManage && (
              <span> Check its headers in Edit.</span>
            )}
          </AlertDescription>
        </Alert>
      )}
      {(busy || error || power.error) && (
        <p
          role={error || power.error ? "alert" : "status"}
          className={
            error || power.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {error ?? power.error ?? busy}
        </p>
      )}
      <SettingsCard title="Connection">
        <dl className="-my-2.5 flex flex-col divide-y">
          <Fact label="Status">
            <StatusBadge server={server} />
          </Fact>
          <Fact label="Transport">
            {server.transport ? TRANSPORTS[server.transport] : "Not reached yet"}
          </Fact>
          {server.protocolVersion && <Fact label="Protocol">{server.protocolVersion}</Fact>}
          <Fact label="Authorization">
            <AuthFact server={server} />
          </Fact>
          {server.serverInfo && (
            <Fact label="Server">
              {server.serverInfo.name}{" "}
              <span className="text-muted-foreground">{server.serverInfo.version}</span>
            </Fact>
          )}
          <Fact label="Tools read">
            {server.toolsReadAt ? <Time iso={server.toolsReadAt} /> : "Not yet"}
          </Fact>
          <Fact label="Used in">
            {scope.kind === "org" ? "Every space of the organization" : "This space"}
          </Fact>
        </dl>
      </SettingsCard>
      <SettingsCard
        title="Tools"
        description={
          scope.kind === "org"
            ? "The policy each tool is used under, or off."
            : "The policy each tool is used under in this space, or off."
        }
        state={tools}
      >
        {toolset && toolset.tools.length > 0 ? (
          <ToolPoliciesProvider scope={scope} canChange={canManage || orgsInSpace}>
            <ToolsetTools toolset={toolset} scope={scope.kind} />
            <PolicyChangeError />
          </ToolPoliciesProvider>
        ) : (
          <p className="text-sm text-muted-foreground">
            {server.toolsReadAt
              ? "The server lists no tools."
              : oauth
                ? "Its tools show once you sign in with the server."
                : "Its tools show once the server answers."}
          </p>
        )}
      </SettingsCard>
      {canManage && (
        <SettingsCard
          title="Remove server"
          description="The agent stops using its tools, and Mage forgets its headers or sign-in."
        >
          <ConfirmDialog
            trigger={<Button variant="destructive" size="sm" />}
            triggerLabel="Remove server"
            title={`Remove ${server.name}?`}
            description="The agent stops using its tools, and Mage forgets how it connects."
            action="Remove"
            onConfirm={remove}
          />
        </SettingsCard>
      )}
      <McpServerDialog
        key={`${server.id}:${server.url}:${server.auth.kind}`}
        scope={scope}
        server={server}
        open={editing}
        onOpenChange={setEditing}
      />
    </>
  );
}
