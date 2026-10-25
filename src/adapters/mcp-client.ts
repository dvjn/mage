// MCP servers reached with the official client: each list or call opens a connection, on the
// transport the server answered on before or else on Streamable HTTP falling back to HTTP+SSE, and
// closes it. Headers go only to the server's own origin. OAuth follows the MCP authorization spec
// through the client's own flow (discovery, registration, PKCE, resource indicators, renewal), its
// state kept wherever the caller keeps it. Whether an address answers as an MCP server is asked
// with a first initialize request of its own.

import {
  auth,
  Client,
  type FetchLike,
  OAuthError,
  type OAuthClientProvider,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import {
  type McpAnswer,
  type McpAuth,
  type McpCallResult,
  type McpClient,
  McpError,
  type McpOAuthClient,
  type McpOAuthStore,
  type McpTarget,
} from "@/ports/mcp.ts";
import type { McpTransport } from "@/shared/mcp.ts";
import type { ToolDefinition } from "@/shared/tools.ts";

export interface McpClientOptions {
  fetch: FetchLike;
  oauth: McpOAuthClient;
  // Mage as servers know it.
  version: string;
}

interface Flow {
  state?: string;
  verifier: { value?: string };
  // Where the flow wants the person sent.
  redirect?: URL;
}

// An OAuth client for the server, its state read and saved through the store.
function providerOf(oauth: McpOAuthStore, client: McpOAuthClient, flow: Flow): OAuthClientProvider {
  const update = (change: (state: ReturnType<McpOAuthStore["load"]>) => void) => {
    const state = oauth.load();
    change(state);
    oauth.save(state);
  };
  return {
    get redirectUrl() {
      return client.redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: client.clientName,
        redirect_uris: [client.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    ...(flow.state && { state: () => flow.state! }),
    clientInformation: () => oauth.load().client as never,
    saveClientInformation: (info) => update((state) => (state.client = { ...info })),
    tokens: () => oauth.load().tokens as never,
    saveTokens: (tokens) => update((state) => (state.tokens = { ...tokens })),
    discoveryState: () => oauth.load().discovery as never,
    saveDiscoveryState: (discovery) => update((state) => (state.discovery = { ...discovery })),
    redirectToAuthorization(url) {
      flow.redirect = url;
    },
    saveCodeVerifier(verifier) {
      flow.verifier.value = verifier;
    },
    codeVerifier() {
      if (!flow.verifier.value) throw new McpError("needs_auth", "Authorize Mage again.");
      return flow.verifier.value;
    },
    // A client people entered is kept; one the server registered is registered again.
    invalidateCredentials: (scope) =>
      update((state) => {
        if (scope === "all" || scope === "tokens") delete state.tokens;
        if (scope === "all" || scope === "discovery") delete state.discovery;
        if ((scope === "all" || scope === "client") && !state.manual) delete state.client;
      }),
  };
}

// A fetch that adds the headers to requests to the server's own origin.
function withHeaders(fetch: FetchLike, url: string, headers: Record<string, string>): FetchLike {
  const origin = new URL(url).origin;
  return (input, init) => {
    if (new URL(String(input)).origin !== origin) return fetch(input, init);
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return fetch(input, { ...init, headers: merged });
  };
}

function hostOf(url: string) {
  return new URL(url).host;
}

// What went wrong, as people read it, and whether authorizing again would help.
export function mcpFailure(err: unknown, target: Pick<McpTarget, "url" | "auth">): McpError {
  if (err instanceof McpError) return err;
  const oauth = target.auth.kind === "oauth";
  const status = err instanceof SdkHttpError ? err.status : null;
  if (err instanceof UnauthorizedError || err instanceof OAuthError) {
    return new McpError(oauth ? "needs_auth" : "error", "The server needs Mage authorized again.");
  }
  if (status === 401 || status === 403) {
    return oauth
      ? new McpError("needs_auth", "The server needs Mage authorized again.")
      : new McpError(
          "error",
          target.auth.kind === "headers"
            ? `The server did not accept the headers (HTTP ${status}).`
            : `The server needs authorization (HTTP ${status}).`,
        );
  }
  if (status) return new McpError("error", `The server answered HTTP ${status}.`);
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) {
    return new McpError("error", "The server did not answer in time.");
  }
  if (err instanceof TypeError) {
    const cause = (err.cause as { code?: string } | undefined)?.code;
    return new McpError(
      "error",
      `Could not reach ${hostOf(target.url)}${cause ? ` (${cause})` : ""}.`,
    );
  }
  return new McpError("error", err instanceof Error ? err.message : String(err));
}

// What went wrong authorizing Mage, as people read it.
function authorizeFailure(err: unknown, url: string): McpError {
  if (err instanceof OAuthError) {
    return new McpError("needs_auth", `The authorization server refused: ${err.message}`);
  }
  if (err instanceof TypeError) return mcpFailure(err, { url, auth: { kind: "none" } });
  return new McpError("needs_auth", err instanceof Error ? err.message : String(err));
}

// Whether a failure on Streamable HTTP means the server may speak only HTTP+SSE.
function olderTransport(err: unknown) {
  const status = err instanceof SdkHttpError ? err.status : null;
  return status !== null && status >= 400 && status < 500 && status !== 401 && status !== 403;
}

// A first initialize request, as any client sends one.
function initializeRequest(version: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Mage", version },
    },
  });
}

// Where an address's OAuth protected-resource metadata is, by RFC 9728.
function resourceMetadataUrl(url: URL) {
  const path = url.pathname === "/" ? "" : url.pathname;
  return new URL(`/.well-known/oauth-protected-resource${path}`, url.origin);
}

function definitionOf(tool: {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}): ToolDefinition {
  const title = tool.title ?? (tool.annotations?.title as string | undefined);
  return {
    name: tool.name,
    ...(title && { title }),
    ...(tool.description && { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
    ...(tool.annotations && { annotations: tool.annotations }),
  };
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const { fetch, oauth: oauthClient, version } = options;

  function transportOf(kind: McpTransport, url: string, auth: McpAuth) {
    const common = {
      fetch: auth.kind === "headers" ? withHeaders(fetch, url, auth.headers) : fetch,
      ...(auth.kind === "oauth" && {
        authProvider: providerOf(auth.state, oauthClient, { verifier: {} }),
      }),
    };
    return kind === "sse"
      ? new SSEClientTransport(new URL(url), common)
      : new StreamableHTTPClientTransport(new URL(url), common);
  }

  async function connectOn(kind: McpTransport, target: McpTarget) {
    const client = new Client({ name: oauthClient.clientName, version });
    await client.connect(transportOf(kind, target.url, target.auth));
    return client;
  }

  // A connected client, and the transport it connected on.
  async function connect(target: McpTarget) {
    if (target.transport) {
      return { client: await connectOn(target.transport, target), transport: target.transport };
    }
    try {
      return {
        client: await connectOn("streamable-http", target),
        transport: "streamable-http" as const,
      };
    } catch (err) {
      if (!olderTransport(err)) throw err;
      try {
        return { client: await connectOn("sse", target), transport: "sse" as const };
      } catch {
        throw err;
      }
    }
  }

  async function using<T>(
    target: McpTarget,
    work: (client: Client, transport: McpTransport) => Promise<T>,
  ) {
    let opened: Awaited<ReturnType<typeof connect>> | null = null;
    try {
      opened = await connect(target);
      return await work(opened.client, opened.transport);
    } catch (err) {
      throw mcpFailure(err, target);
    } finally {
      await opened?.client.close().catch(() => {});
    }
  }

  // Whether the address's protected-resource metadata is there.
  async function describesResource(url: URL) {
    try {
      const res = await fetch(resourceMetadataUrl(url), {
        headers: { Accept: "application/json" },
      });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  return {
    async probe(url, headers) {
      const address = new URL(url);
      let res: Response;
      try {
        res = await withHeaders(
          fetch,
          url,
          headers,
        )(address, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: initializeRequest(version),
        });
      } catch {
        return "unreachable";
      }
      await res.body?.cancel();
      let answer: McpAnswer = "other";
      if (res.ok) {
        const type = res.headers.get("content-type") ?? "";
        if (/application\/json|text\/event-stream/.test(type)) answer = "mcp";
        // Ends the session the request began, if it began one.
        const session = res.headers.get("mcp-session-id");
        if (session) {
          await withHeaders(
            fetch,
            url,
            headers,
          )(address, {
            method: "DELETE",
            headers: { "Mcp-Session-Id": session },
          })
            .then((done) => done.body?.cancel())
            .catch(() => {});
        }
      } else if (res.status === 401) {
        const challenge = res.headers.get("www-authenticate") ?? "";
        answer =
          /resource_metadata=/i.test(challenge) || (await describesResource(address))
            ? "mcp"
            : "auth";
      } else if (res.status === 403) {
        answer = "auth";
      }
      return answer;
    },

    list(target) {
      return using(target, async (client, transport) => {
        const { tools } = await client.listTools();
        const info = client.getServerVersion();
        return {
          transport,
          serverInfo: info ? { name: info.name, version: info.version } : null,
          tools: tools.map(definitionOf),
        };
      });
    },

    call(target, name, args, signal) {
      return using(target, async (client) => {
        const result = await client.callTool({ name, arguments: args }, { signal });
        return result as McpCallResult;
      });
    },

    async authorize(url, oauth, state, pending) {
      const flow: Flow = { state, verifier: pending };
      try {
        const result = await auth(providerOf(oauth, oauthClient, flow), {
          serverUrl: url,
          fetchFn: fetch,
        });
        return result === "REDIRECT" && flow.redirect ? flow.redirect.href : null;
      } catch (err) {
        throw authorizeFailure(err, url);
      }
    },

    async finish(url, oauth, verifier, callback) {
      try {
        await auth(providerOf(oauth, oauthClient, { verifier: { value: verifier } }), {
          serverUrl: url,
          fetchFn: fetch,
          authorizationCode: callback.code,
          ...(callback.iss && { iss: callback.iss }),
        });
      } catch (err) {
        throw authorizeFailure(err, url);
      }
    },
  };
}
