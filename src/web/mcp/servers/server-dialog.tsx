// Adding or changing an MCP server in a dialog: its address, the short name the agent knows it by,
// and how it is authorized (not at all, by headers with a bearer token among them, or by OAuth,
// which sends the browser to the server's authorization server and back). Header values and
// secrets are only ever typed, never shown again beyond their ends.

import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import {
  type McpAuthInput,
  type McpAuthKind,
  type McpServerSummary,
  mcpSlugOf,
} from "@/shared/mcp.ts";
import { SegmentedControl } from "@/web/components/segmented-control";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { WithTooltip } from "@/web/components/with-tooltip";
import type { Scope } from "@/web/shell/scope";
import { pageLink } from "@/web/mcp/servers/row";
import { useAuthorizeServer, useSaveServer } from "@/web/mcp/mutations";

const AUTH_KINDS: { value: McpAuthKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "headers", label: "Headers" },
  { value: "oauth", label: "OAuth" },
];

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
    .map((row) => ({
      name: row.name.trim(),
      value: row.value || (row.stored ? null : ""),
    }));
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
    .map((header, key) => ({
      key,
      name: header.name,
      value: "",
      hint: header.hint,
      stored: true,
    }));
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
  scope: Scope;
  // The server to change; none to add one.
  server?: McpServerSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
  const [slug, setSlug] = useState(server?.slug ?? "");
  const [url, setUrl] = useState(initial.url);
  const [kind, setKind] = useState<McpAuthKind>(initial.kind);
  const [token, setToken] = useState("");
  const [tokenHint, setTokenHint] = useState(initial.tokenHint);
  const [rows, setRows] = useState<HeaderDraft[]>(initial.rows);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const save = useSaveServer(scope, server?.id);
  const signingIn = useAuthorizeServer();
  const error = save.error?.message;
  const pending = save.isPending
    ? server
      ? "Saving…"
      : kind === "oauth"
        ? "Adding…"
        : "Connecting…"
    : signingIn.isPending
      ? "Opening sign-in…"
      : undefined;

  function reset() {
    setName(initial.name);
    setSlug(server?.slug ?? "");
    setUrl(initial.url);
    setKind(initial.kind);
    setToken("");
    setTokenHint(initial.tokenHint);
    setRows(initial.rows);
    setClientId(initial.clientId);
    setClientSecret("");
    save.reset();
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
        return {
          kind,
          clientId: clientId.trim() || null,
          clientSecret: clientSecret || null,
        };
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
    const json = {
      name: name.trim(),
      ...(slug.trim() && slug.trim() !== server?.slug && { slug: slug.trim() }),
      url: url.trim(),
      auth: authBody(),
    };
    const saved = await save.mutateAsync(json).catch(() => null);
    if (!saved) return;
    if (saved.auth.kind === "oauth" && !saved.auth.authorized) {
      // A failure is kept with the server; its page says what went wrong and offers to try again.
      await signingIn.mutateAsync(saved.id).catch(() => {});
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
              <FieldLabel htmlFor={`${id}-slug`}>Short name</FieldLabel>
              <Input
                id={`${id}-slug`}
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder={mcpSlugOf(name || "linear")}
                maxLength={32}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
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
