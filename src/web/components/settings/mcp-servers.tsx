// MCP servers in settings: a card listing the org's servers, or for a space the org's tagged as
// such beside its own, each a row that opens its page, with how it answered, its tools' modes and
// a switch that turns it on or off: a server's own for those who manage it, or for the org's in a
// space whether the space uses it, which stays off while the org has the server off; adding one
// in a dialog, by its address and how it is authorized (not at all, by headers with a bearer token
// among them, or by OAuth, which sends the browser to the server's authorization server and back);
// and a server's page with its switch, its connection, its tools and their modes, reading them
// again, reconnecting, changing everything about it in the same form it was added with, and
// removing it. One of the org's servers opened from a space shows there with the space's switch
// and the space's modes for its tools, the rest of it the org's to manage. Header values and
// secrets are only ever typed, never shown again beyond their ends.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import {
  type McpAuthInput,
  type McpAuthKind,
  mcpAuthorizeSchema,
  type McpServerSummary,
  mcpServerSchema,
  mcpToolsetId,
  type SpaceOrgMcpServer,
} from "@/shared/mcp.ts";
import type { ToolsetSetting } from "@/shared/tools.ts";
import { LoadError } from "@/web/components/page-states";
import { SettingsCard, SettingsTitle } from "@/web/components/settings/layout";
import {
  ModeCounts,
  ToolsetTools,
  useOrgTools,
  useSpaceTools,
} from "@/web/components/settings/tools-list";
import { SegmentedControl } from "@/web/components/segmented-control";
import { Time } from "@/web/components/time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/web/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/web/components/ui/alert";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Switch } from "@/web/components/ui/switch";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import {
  mcpServerQuery,
  meQuery,
  orgMcpServersQuery,
  spaceMcpServersQuery,
} from "@/web/lib/queries";
import { cn } from "cn";

// Whose servers: the org's, or one space's own.
export type McpScope = { kind: "org" } | { kind: "space"; spaceId: string };

const TRANSPORTS: Record<NonNullable<McpServerSummary["transport"]>, string> = {
  "streamable-http": "Streamable HTTP",
  sse: "HTTP+SSE (older)",
};

const AUTH_KINDS: { value: McpAuthKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "headers", label: "Headers" },
  { value: "oauth", label: "OAuth" },
];

function hostOf(url: string) {
  return URL.parse(url)?.host ?? url;
}

// A server's page, by its scope.
function pageLink(scope: McpScope, serverId: string) {
  return scope.kind === "org"
    ? ({ to: "/org/tools/mcp/$serverId", params: { serverId } } as const)
    : ({
        to: "/s/$spaceId/settings/tools/mcp/$serverId",
        params: { spaceId: scope.spaceId, serverId },
      } as const);
}

// How the server answered when last reached, in a word or two.
function statusOf(server: McpServerSummary): { label: string; tone: "ok" | "ask" | "error" } {
  if (server.status === "error") return { label: "Can't connect", tone: "error" };
  if (server.status === "needs_auth") {
    const never = server.auth.kind === "oauth" && !server.auth.authorized && !server.toolsReadAt;
    return { label: never ? "Not connected" : "Needs reconnecting", tone: "ask" };
  }
  return { label: "Connected", tone: "ok" };
}

function StatusBadge({ server }: { server: McpServerSummary }) {
  const { label, tone } = statusOf(server);
  if (tone === "error") return <Badge variant="destructive">{label}</Badge>;
  if (tone === "ask") {
    return (
      <Badge variant="outline" className="border-tool-ask/40 text-tool-ask">
        {label}
      </Badge>
    );
  }
  return <Badge variant="secondary">{label}</Badge>;
}

// Sends the browser to authorize Mage with the server, or reads it again when it needed no one.
async function authorize(id: string) {
  const res = await apiClient.v1["mcp-servers"][":id"].authorize.$post({ param: { id } });
  if (!res.ok) return { error: await errorOf(res) };
  const result = mcpAuthorizeSchema.parse(await res.json());
  if (result.status === "redirect") {
    window.location.assign(result.url);
    return { redirecting: true as const };
  }
  return { server: result.server };
}

export function McpServersCard({
  scope,
  toolsets,
  canManage,
}: {
  scope: McpScope;
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
type Row = { kind: "org"; server: SpaceOrgMcpServer } | { kind: "own"; server: McpServerSummary };

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
      rows={(servers.data?.servers ?? []).map((server) => ({ kind: "own", server }))}
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
        ...(servers.data?.org ?? []).map((server): Row => ({ kind: "org", server })),
        ...(servers.data?.own ?? []).map((server): Row => ({ kind: "own", server })),
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
  scope: McpScope;
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
          <Button variant="outline" size="sm" disabled={!allowed} onClick={() => setAdding(true)}>
            <PlusIcon />
            Add server
          </Button>
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
          <ul className="-my-2 flex flex-col divide-y">
            {rows.map((row) => (
              <ServerRow
                key={row.server.id}
                scope={scope}
                row={row}
                canManage={canManage}
                toolset={toolsets.find((toolset) => toolset.id === mcpToolsetId(row.server.id))}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "No servers yet. Add one by its address to give the agent its tools."
              : "No servers yet."}
          </p>
        )}
        {spaceServers !== null && (
          <SpaceServersSwitch allowed={spaceServers} canManage={canManage} />
        )}
      </div>
      <McpServerDialog scope={scope} open={adding} onOpenChange={setAdding} />
    </SettingsCard>
  );
}

// Turns a server on or off, or one of the org's for a space, and refreshes what offers its tools.
function useServerSwitch(scope: McpScope) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();

  async function settled() {
    await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    await queryClient.invalidateQueries({ queryKey: ["org-tools"] });
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  async function setEnabled(server: McpServerSummary, enabled: boolean) {
    setError(undefined);
    const res = await apiClient.v1["mcp-servers"][":id"].enabled.$put({
      param: { id: server.id },
      json: { enabled },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(mcpServerQuery(server.id).queryKey, await res.json());
    await settled();
  }

  async function setInSpace(server: McpServerSummary, enabled: boolean) {
    if (scope.kind !== "space") return;
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"]["mcp-servers"][":serverId"].$put({
      param: { id: scope.spaceId, serverId: server.id },
      json: { enabled },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(spaceMcpServersQuery(scope.spaceId).queryKey, await res.json());
    await settled();
  }

  return { error, setEnabled, setInSpace };
}

function ServerRow({
  scope,
  row,
  canManage,
  toolset,
}: {
  scope: McpScope;
  row: Row;
  canManage: boolean;
  toolset: ToolsetSetting | undefined;
}) {
  const { server } = row;
  const { error, setEnabled, setInSpace } = useServerSwitch(scope);
  const link = pageLink(scope, server.id);
  // The org's server as a space sees it: off there while the org has it off.
  const orgOff = row.kind === "org" && !server.enabled;
  const on = row.kind === "org" ? row.server.enabled && row.server.inSpace : server.enabled;
  const ok = server.status === "ok";
  const count = server.toolCount;
  return (
    <li
      aria-label={server.name}
      className="group relative isolate flex items-center gap-3 rounded-md py-3 has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50"
    >
      <Link
        {...link}
        className="flex min-w-0 flex-1 items-center gap-3 outline-none after:absolute after:inset-0 after:rounded-md"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          <PlugIcon className="size-4" />
        </span>
        <span className={cn("flex min-w-0 flex-1 flex-col", !on && "text-muted-foreground")}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{server.name}</span>
            {row.kind === "org" && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                Org
              </Badge>
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {orgOff ? "Turned off by the organization" : hostOf(server.url)}
          </span>
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {ok ? (
          <>
            <span className="hidden sm:inline">{count === 1 ? "1 tool" : `${count} tools`}</span>
            {toolset && <ModeCounts tools={toolset.tools} />}
          </>
        ) : (
          <StatusBadge server={server} />
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
        <Switch
          size="sm"
          className="relative z-10"
          aria-label={row.kind === "org" && scope.kind === "space" ? "On in this space" : "On"}
          checked={on}
          disabled={orgOff || (row.kind === "own" && !canManage)}
          onCheckedChange={(next) =>
            void (row.kind === "org" ? setInSpace(server, next) : setEnabled(server, next))
          }
        />
        <ChevronRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </li>
  );
}

function SpaceServersSwitch({ allowed, canManage }: { allowed: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [error, setError] = useState<string>();

  async function change(next: boolean) {
    setError(undefined);
    const res = await apiClient.v1.org["mcp-servers"]["space-servers"].$put({
      json: { allowed: next },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(orgMcpServersQuery.queryKey, await res.json());
    await queryClient.invalidateQueries({ queryKey: ["mcp-servers", "space"] });
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  return (
    <Field orientation="horizontal" className="border-t pt-4">
      <FieldContent>
        <FieldLabel htmlFor={id}>Spaces can add their own</FieldLabel>
        <FieldDescription>
          Those who manage a space add servers only its threads use.
        </FieldDescription>
        <FieldError>{error}</FieldError>
      </FieldContent>
      <Switch
        id={id}
        checked={allowed}
        disabled={!canManage}
        onCheckedChange={(next) => void change(next)}
      />
    </Field>
  );
}

interface HeaderDraft {
  key: number;
  name: string;
  value: string;
  // The end of the value stored on the server, kept unless a new one is typed.
  hint?: string;
  stored: boolean;
}

function nextKey(rows: HeaderDraft[]) {
  return Math.max(0, ...rows.map((row) => row.key)) + 1;
}

// The headers as the API takes them: a stored one left blank keeps its value.
function headersBody(rows: HeaderDraft[]) {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => ({ name: row.name.trim(), value: row.value || (row.stored ? null : "") }));
}

function HeaderFields({
  rows,
  onChange,
}: {
  rows: HeaderDraft[];
  onChange: (rows: HeaderDraft[]) => void;
}) {
  function change(key: number, update: Partial<HeaderDraft>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...update } : row)));
  }
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className="flex gap-2">
          <Input
            aria-label="Header name"
            value={row.name}
            disabled={row.stored}
            onChange={(event) => change(row.key, { name: event.target.value })}
            placeholder="Name"
            autoComplete="off"
          />
          <Input
            aria-label={`Value of ${row.name || "header"}`}
            type="password"
            value={row.value}
            onChange={(event) => change(row.key, { value: event.target.value })}
            placeholder={row.stored ? (row.hint ?? "••••") : "Value"}
            autoComplete="off"
          />
          <WithTooltip label="Remove header">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${row.name || "header"}`}
              onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
            >
              <XIcon />
            </Button>
          </WithTooltip>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit self-start"
        onClick={() =>
          onChange([...rows, { key: nextKey(rows), name: "", value: "", stored: false }])
        }
      >
        <PlusIcon />
        Add header
      </Button>
    </>
  );
}

// The headers of a server authorized by them, apart from its Authorization header.
function storedRows(server: McpServerSummary | undefined): HeaderDraft[] {
  if (server?.auth.kind !== "headers") return [];
  return server.auth.headers
    .filter((header) => header.name !== "authorization")
    .map((header, key) => ({ key, name: header.name, value: "", hint: header.hint, stored: true }));
}

// The end of the stored Authorization header, for a server authorized by headers.
function storedToken(server: McpServerSummary | undefined) {
  if (server?.auth.kind !== "headers") return null;
  return server.auth.headers.find((header) => header.name === "authorization")?.hint ?? null;
}

// Adding a server, or changing one: the same form, filled in with what is stored apart from its
// secrets, of which only the ends show.
export function McpServerDialog({
  scope,
  server,
  open,
  onOpenChange,
}: {
  scope: McpScope;
  // The server to change; none to add one.
  server?: McpServerSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = useId();
  const entered = server?.auth.kind === "oauth" && server.auth.registration === "manual";
  const initial = {
    name: server?.name ?? "",
    url: server?.url ?? "",
    kind: server?.auth.kind ?? ("none" as McpAuthKind),
    tokenHint: storedToken(server),
    rows: storedRows(server),
    clientId: (entered && server.auth.kind === "oauth" && server.auth.clientId) || "",
    secretHint: (server?.auth.kind === "oauth" && server.auth.clientSecretHint) || null,
  };
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [kind, setKind] = useState<McpAuthKind>(initial.kind);
  const [token, setToken] = useState("");
  const [tokenHint, setTokenHint] = useState(initial.tokenHint);
  const [rows, setRows] = useState<HeaderDraft[]>(initial.rows);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();

  function reset() {
    setName(initial.name);
    setUrl(initial.url);
    setKind(initial.kind);
    setToken("");
    setTokenHint(initial.tokenHint);
    setRows(initial.rows);
    setClientId(initial.clientId);
    setClientSecret("");
    setError(undefined);
    setPending(undefined);
  }

  // The client secret shows as stored while the client entered before stays.
  const secretKept = !!initial.secretHint && clientId.trim() === initial.clientId;

  function authBody(): McpAuthInput {
    switch (kind) {
      case "none":
        return { kind };
      case "headers":
        return {
          kind,
          headers: [
            ...(token.trim()
              ? [{ name: "Authorization", value: `Bearer ${token.trim()}` }]
              : tokenHint
                ? [{ name: "Authorization", value: null }]
                : []),
            ...headersBody(rows),
          ],
        };
      case "oauth":
        return { kind, clientId: clientId.trim() || null, clientSecret: clientSecret || null };
    }
  }

  // Whether saving leaves an OAuth server to sign in with: a new one, or one whose address,
  // client or tokens no longer hold.
  const signIn =
    kind === "oauth" &&
    (!server ||
      server.auth.kind !== "oauth" ||
      !server.auth.authorized ||
      url.trim() !== server.url ||
      clientId.trim() !== initial.clientId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(server ? "Saving…" : kind === "oauth" ? "Adding…" : "Connecting…");
    const json = { name: name.trim(), url: url.trim(), auth: authBody() };
    const res = server
      ? await apiClient.v1["mcp-servers"][":id"].$patch({ param: { id: server.id }, json })
      : scope.kind === "org"
        ? await apiClient.v1.org["mcp-servers"].$post({ json })
        : await apiClient.v1.spaces[":id"]["mcp-servers"].$post({
            param: { id: scope.spaceId },
            json,
          });
    if (!res.ok) {
      setPending(undefined);
      setError(await errorOf(res));
      return;
    }
    const saved = mcpServerSchema.parse(await res.json());
    queryClient.setQueryData(mcpServerQuery(saved.id).queryKey, saved);
    await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    await queryClient.invalidateQueries({ queryKey: ["org-tools"] });
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
    if (saved.auth.kind === "oauth" && !saved.auth.authorized) {
      setPending("Opening sign-in…");
      const result = await authorize(saved.id);
      if ("redirecting" in result) return;
      if ("error" in result) {
        // The server is kept; its page says what went wrong and offers to try again.
        await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      }
    }
    onOpenChange(false);
    reset();
    if (!server) await navigate(pageLink(scope, saved.id));
  }

  const missing =
    !name.trim() ||
    !url.trim() ||
    (kind === "headers" && !token.trim() && !tokenHint && !headersBody(rows).length);
  const action = server
    ? signIn
      ? "Save and sign in"
      : "Save"
    : signIn
      ? "Add and sign in"
      : "Add server";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next || server) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
          <DialogDescription>
            {server
              ? "Header values and secrets left blank keep the ones stored."
              : "A server reached over Streamable HTTP, or the older HTTP+SSE. Servers run as local commands (stdio) are not supported."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Linear"
                maxLength={80}
                autoComplete="off"
                autoFocus={!server}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-url`}>Server URL</FieldLabel>
              <Input
                id={`${id}-url`}
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/mcp"
                autoComplete="off"
              />
              {server?.auth.kind === "oauth" && kind === "oauth" && url.trim() !== server.url && (
                <FieldDescription>A new address needs signing in again.</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel>Authorization</FieldLabel>
              <SegmentedControl
                label="Authorization"
                options={AUTH_KINDS}
                value={kind}
                onChange={setKind}
                className="w-fit"
              />
            </Field>
            {kind === "headers" && (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-token`}>Bearer token</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id={`${id}-token`}
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder={tokenHint ?? "Optional"}
                      autoComplete="off"
                    />
                    {tokenHint && !token && (
                      <WithTooltip label="Remove token">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove token"
                          onClick={() => setTokenHint(null)}
                        >
                          <XIcon />
                        </Button>
                      </WithTooltip>
                    )}
                  </div>
                  <FieldDescription>Sent as Authorization: Bearer and the token.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Other headers</FieldLabel>
                  <HeaderFields rows={rows} onChange={setRows} />
                  <FieldDescription>
                    Sent with every request to the server, and never shown again.
                  </FieldDescription>
                </Field>
              </>
            )}
            {kind === "oauth" && (
              <>
                <p className="text-sm text-muted-foreground">
                  {signIn ? "You sign in with the server next. " : ""}Everyone the server is for
                  uses this one connection.
                </p>
                <Field>
                  <FieldLabel htmlFor={`${id}-client`}>Client ID</FieldLabel>
                  <Input
                    id={`${id}-client`}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    placeholder="Optional"
                    autoComplete="off"
                  />
                  <FieldDescription>
                    Only for a server that does not register Mage itself.
                  </FieldDescription>
                </Field>
                {clientId.trim() && (
                  <Field>
                    <FieldLabel htmlFor={`${id}-secret`}>Client secret</FieldLabel>
                    <Input
                      id={`${id}-secret`}
                      type="password"
                      value={clientSecret}
                      onChange={(event) => setClientSecret(event.target.value)}
                      placeholder={secretKept ? (initial.secretHint ?? "") : "Optional"}
                      autoComplete="off"
                    />
                  </Field>
                )}
              </>
            )}
            <FieldError>{error}</FieldError>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!!pending || missing}>
              {pending ?? action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
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

export function McpServerPage({ scope, serverId }: { scope: McpScope; serverId: string }) {
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
  return scope.kind === "org" ? (
    <OrgServer server={server.data} />
  ) : (
    <SpaceServer server={server.data} spaceId={scope.spaceId} />
  );
}

function OrgServer({ server }: { server: McpServerSummary }) {
  const tools = useOrgTools();
  return <ServerDetail scope={{ kind: "org" }} server={server} tools={tools} />;
}

function SpaceServer({ server, spaceId }: { server: McpServerSummary; spaceId: string }) {
  const tools = useSpaceTools(spaceId);
  return <ServerDetail scope={{ kind: "space", spaceId }} server={server} tools={tools} />;
}

function BackToTools({ scope }: { scope: McpScope }) {
  return (
    <Link
      {...(scope.kind === "org"
        ? { to: "/org/tools" as const }
        : { to: "/s/$spaceId/settings/tools" as const, params: { spaceId: scope.spaceId } })}
      className="-mb-4 flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      Tools
    </Link>
  );
}

function ServerDetail({
  scope,
  server,
  tools,
}: {
  scope: McpScope;
  server: McpServerSummary;
  tools: ReturnType<typeof useOrgTools>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  // One of the org's servers, seen from a space: the space says whether it uses it, and sets its
  // tools' modes; the rest is the org's.
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
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const toolset = tools.tools.data?.find((found) => found.id === mcpToolsetId(server.id));
  const oauth = server.auth.kind === "oauth";
  const status = statusOf(server);
  const power = useServerSwitch(scope);

  async function settled(next: McpServerSummary) {
    queryClient.setQueryData(mcpServerQuery(server.id).queryKey, next);
    await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    await queryClient.invalidateQueries({ queryKey: ["org-tools"] });
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  async function refresh() {
    setBusy("Reading tools…");
    setError(undefined);
    const res = await apiClient.v1["mcp-servers"][":id"].refresh.$post({
      param: { id: server.id },
    });
    setBusy(undefined);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await settled(mcpServerSchema.parse(await res.json()));
  }

  async function reconnect() {
    setBusy("Opening sign-in…");
    setError(undefined);
    const result = await authorize(server.id);
    if ("redirecting" in result) return;
    setBusy(undefined);
    if ("error" in result) {
      setError(result.error);
      await queryClient.invalidateQueries({ queryKey: mcpServerQuery(server.id).queryKey });
      return;
    }
    await settled(result.server);
  }

  async function remove() {
    const res = await apiClient.v1["mcp-servers"][":id"].$delete({ param: { id: server.id } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    await queryClient.invalidateQueries({ queryKey: ["org-tools"] });
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
    await navigate(
      scope.kind === "org"
        ? { to: "/org/tools" }
        : { to: "/s/$spaceId/settings/tools", params: { spaceId: scope.spaceId } },
    );
  }

  const connect = oauth && (
    <Button size="sm" disabled={!!busy} onClick={() => void reconnect()}>
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
                disabled={!server.enabled || inSpace.data === undefined || !!inSpace.error}
                onCheckedChange={(next) => void power.setInSpace(server, next)}
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
                    onCheckedChange={(next) => void power.setEnabled(server, next)}
                  />
                </label>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void refresh()}
                >
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
          Managed by the organization: its connection and the loosest its tools can be are set
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
            ? "Whether each runs, asks first, or is off. Spaces can only make these stricter."
            : orgsInSpace
              ? "Whether each runs, asks first, or is off in this space; only stricter than the organization has it."
              : "Whether each runs, asks first, or is off in this space."
        }
        state={tools.tools}
      >
        {toolset && toolset.tools.length > 0 ? (
          <>
            <ToolsetTools
              toolset={toolset}
              scope={scope.kind}
              canChange={canManage || orgsInSpace}
              onChange={tools.change}
            />
            <FieldError>{tools.error}</FieldError>
          </>
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
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
              Remove server
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The agent stops using its tools, and Mage forgets how it connects.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void remove()}>
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
