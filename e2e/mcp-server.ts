// A stand-in MCP server for the browser journeys and the tests, as people run their own: a notes
// server whose tools are open at /mcp, behind headers at /headers/mcp, behind OAuth at /oauth/mcp,
// and over the older HTTP+SSE transport at /sse. Its OAuth comes from its own small authorization
// server: protected resource and server metadata, client registration, an authorize page that
// approves at once, and tokens with their renewal. POST /control/revoke forgets every token, as
// when a person revokes the app. It can instead keep its OAuth server at /mcp, where the open one
// was, as servers that live only behind OAuth do. Each Streamable HTTP server also answers under
// /modern speaking only the 2026-07-28 revision: it describes itself to server/discover, wants the
// revision in each request's _meta, and refuses the older initialize handshake as rmcp servers do.

import { createHash, randomBytes } from "node:crypto";

import { serve } from "@hono/node-server";

// What /headers/mcp takes: this bearer token, or this key in X-Api-Key.
export const MCP_BEARER_TOKEN = "mcp-journey-token";
export const MCP_API_KEY = "mcp-journey-key";

export interface McpStandInOptions {
  // Where it is reached; the authorization server's issuer.
  origin: string;
  // Whether clients may register themselves; when not, only these clients are known.
  registration?: boolean;
  clients?: { id: string; secret?: string }[];
  // Where the server behind OAuth is; /mcp puts it in place of the open one.
  oauthPath?: "/oauth/mcp" | "/mcp";
}

interface JsonRpc {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

// The one revision the /modern servers speak, and where a request names the revision it is in.
export const MODERN_REVISION = "2026-07-28";
const REVISION_KEY = "io.modelcontextprotocol/protocolVersion";

const SERVER_INFO = { name: "Notes", version: "1.0.0" };

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Say the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", title: "Text" } },
      required: ["text"],
    },
    outputSchema: {
      type: "object",
      properties: { text: { type: "string", title: "Text" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_note",
    title: "Add note",
    description: "Write a note with a title and a body.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", title: "Title" },
        body: { type: "string", title: "Body" },
      },
      required: ["title"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", title: "Note" },
        title: { type: "string", title: "Title" },
        words: { type: "number", title: "Words", description: "In the body" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "delete_note",
    title: "Delete note",
    description: "Delete a note for good.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", title: "Note" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function base64url(buffer: Buffer) {
  return buffer.toString("base64url");
}

function token() {
  return base64url(randomBytes(24));
}

export function mcpStandIn(options: McpStandInOptions) {
  const { origin, oauthPath = "/oauth/mcp" } = options;
  const notes = new Map<string, { title: string; body: string }>();
  const clients = new Map<string, { secret?: string; redirectUris: string[] | null }>(
    (options.clients ?? []).map((client) => [
      client.id,
      { secret: client.secret, redirectUris: null },
    ]),
  );
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource: string | null }
  >();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>();
  // The legacy transport's open streams, by session.
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  // Where the server behind OAuth is, in either revision.
  const oauthResources = [`${origin}${oauthPath}`, `${origin}/modern${oauthPath}`];

  function answer(message: JsonRpc): unknown {
    switch (message.method) {
      case "initialize": {
        const asked = text(message.params?.protocolVersion);
        return {
          protocolVersion: asked.startsWith("2025") ? asked : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return call(
          String(message.params?.name),
          (message.params?.arguments ?? {}) as Record<string, unknown>,
        );
      default:
        return null;
    }
  }

  function call(name: string, args: Record<string, unknown>) {
    switch (name) {
      case "echo": {
        const said = text(args.text);
        return { content: [{ type: "text", text: said }], structuredContent: { text: said } };
      }
      case "add_note": {
        const id = `note-${notes.size + 1}`;
        const title = text(args.title);
        const body = text(args.body);
        notes.set(id, { title, body });
        const words = body.split(/\s+/).filter(Boolean).length;
        const note = { id, title, words };
        return { content: [{ type: "text", text: JSON.stringify(note) }], structuredContent: note };
      }
      case "delete_note": {
        const id = text(args.id);
        if (!notes.delete(id)) {
          return { content: [{ type: "text", text: `No note has id ${id}.` }], isError: true };
        }
        return { content: [{ type: "text", text: `Deleted ${id}.` }] };
      }
      default:
        return { content: [{ type: "text", text: `No tool is named ${name}.` }], isError: true };
    }
  }

  function reply(message: JsonRpc) {
    const result = answer(message);
    return result === null
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id: message.id, result };
  }

  // Streamable HTTP: each POST answered in its body; no stream of the server's own.
  async function streamable(req: Request, modern: boolean) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const message = (await req.json()) as JsonRpc;
    if (message.id === undefined) return new Response(null, { status: 202 });
    return modern ? modernReply(message) : json(reply(message));
  }

  function failed(message: JsonRpc, status: number, error: Record<string, unknown>) {
    return json({ jsonrpc: "2.0", id: message.id, error }, status);
  }

  // A request in the 2026-07-28 revision: the revision it is in named in its own _meta, each
  // result saying it is complete, and the older handshake refused with the revisions there are.
  function modernReply(message: JsonRpc) {
    const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
    const asked =
      message.method === "initialize" ? message.params?.protocolVersion : meta[REVISION_KEY];
    if (asked === undefined) {
      return failed(message, 400, {
        code: -32602,
        message: "Invalid params: request requires protocolVersion in request _meta",
      });
    }
    if (asked !== MODERN_REVISION) {
      return failed(message, 400, {
        code: -32022,
        message: "Unsupported protocol version",
        data: { requested: asked, supported: [MODERN_REVISION] },
      });
    }
    let result: unknown;
    switch (message.method) {
      case "server/discover":
        result = {
          supportedVersions: [MODERN_REVISION],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        };
        break;
      case "tools/list":
        result = { tools: TOOLS, ttlMs: 0, cacheScope: "private" };
        break;
      case "tools/call":
        result = answer(message);
        break;
      default:
        return failed(message, 404, { code: -32601, message: "Method not found" });
    }
    return json({
      jsonrpc: "2.0",
      id: message.id,
      result: { resultType: "complete", ...(result as object) },
    });
  }

  function headersAllowed(req: Request) {
    return (
      req.headers.get("authorization") === `Bearer ${MCP_BEARER_TOKEN}` ||
      req.headers.get("x-api-key") === MCP_API_KEY
    );
  }

  function bearerAllowed(req: Request) {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && accessTokens.has(header.slice(7));
  }

  function openStream() {
    const session = token();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.set(session, controller);
        controller.enqueue(
          encoder.encode(`event: endpoint\ndata: /messages?session=${session}\n\n`),
        );
      },
      cancel() {
        streams.delete(session);
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  async function legacyMessage(req: Request, url: URL) {
    const controller = streams.get(url.searchParams.get("session") ?? "");
    if (!controller) return new Response("No such session", { status: 404 });
    const message = (await req.json()) as JsonRpc;
    if (message.id !== undefined) {
      const data = JSON.stringify(reply(message));
      controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${data}\n\n`));
    }
    return new Response("Accepted", { status: 202 });
  }

  function authorizationMetadata() {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      ...(options.registration !== false && { registration_endpoint: `${origin}/register` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["notes"],
    });
  }

  async function register(req: Request) {
    if (options.registration === false) return json({ error: "invalid_request" }, 400);
    const metadata = (await req.json()) as { redirect_uris?: string[] };
    const id = `client-${token()}`;
    clients.set(id, { redirectUris: metadata.redirect_uris ?? [] });
    return json({ ...metadata, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
  }

  function authorize(url: URL) {
    const params = url.searchParams;
    const client = clients.get(params.get("client_id") ?? "");
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!client || (client.redirectUris && !client.redirectUris.includes(redirectUri))) {
      return new Response("Unknown client or redirect", { status: 400 });
    }
    const challenge = params.get("code_challenge");
    if (!challenge || params.get("code_challenge_method") !== "S256") {
      return new Response("PKCE is required", { status: 400 });
    }
    const code = token();
    codes.set(code, {
      clientId: params.get("client_id")!,
      redirectUri,
      challenge,
      resource: params.get("resource"),
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = params.get("state");
    if (state) back.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: back.href } });
  }

  // The client named in the body or by basic authentication, when its secret matches.
  function clientOf(req: Request, form: URLSearchParams) {
    const basic = req.headers.get("authorization");
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    if (basic?.startsWith("Basic ")) {
      const [user, pass] = Buffer.from(basic.slice(6), "base64").toString().split(":");
      id = decodeURIComponent(user ?? "");
      secret = decodeURIComponent(pass ?? "");
    }
    const client = id ? clients.get(id) : undefined;
    if (!client || (client.secret && client.secret !== secret)) return null;
    return id;
  }

  function issue(clientId: string) {
    const access = token();
    const refresh = token();
    accessTokens.add(access);
    refreshTokens.set(refresh, clientId);
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: "notes",
    });
  }

  async function tokenEndpoint(req: Request) {
    const form = new URLSearchParams(await req.text());
    const clientId = clientOf(req, form);
    if (!clientId) return json({ error: "invalid_client" }, 401);
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      if (
        !code ||
        code.clientId !== clientId ||
        code.redirectUri !== form.get("redirect_uri") ||
        code.challenge !== challenge ||
        !oauthResources.includes(code.resource ?? "")
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      return issue(clientId);
    }
    if (form.get("grant_type") === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      if (refreshTokens.get(refresh) !== clientId) return json({ error: "invalid_grant" }, 400);
      refreshTokens.delete(refresh);
      return issue(clientId);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const modern = url.pathname.startsWith("/modern/");
    const path = modern ? url.pathname.slice("/modern".length) : url.pathname;
    const prefix = modern ? "/modern" : "";
    if (path === oauthPath) {
      if (!bearerAllowed(req)) {
        return json({ error: "invalid_token" }, 401, {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${prefix}${oauthPath}"`,
        });
      }
      return streamable(req, modern);
    }
    const described = oauthResources.find(
      (resource) =>
        url.pathname === `/.well-known/oauth-protected-resource${new URL(resource).pathname}`,
    );
    if (described) {
      return json({
        resource: described,
        authorization_servers: [origin],
        scopes_supported: ["notes"],
      });
    }
    if (modern && path !== "/mcp" && path !== "/headers/mcp") {
      return new Response("Not found", { status: 404 });
    }
    switch (path) {
      case "/mcp":
        return streamable(req, modern);
      case "/headers/mcp":
        if (!headersAllowed(req)) return json({ error: "Give the key" }, 401);
        return streamable(req, modern);
      case "/sse":
        return req.method === "GET" ? openStream() : new Response(null, { status: 405 });
      case "/messages":
        return legacyMessage(req, url);
      case "/.well-known/oauth-authorization-server":
        return authorizationMetadata();
      case "/register":
        return register(req);
      case "/authorize":
        return authorize(url);
      case "/token":
        return tokenEndpoint(req);
      case "/control/revoke":
        accessTokens.clear();
        refreshTokens.clear();
        return json({ ok: true });
      default:
        return new Response("Not found", { status: 404 });
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? "4791");
  serve({ fetch: mcpStandIn({ origin: `http://localhost:${port}` }), port });
}
