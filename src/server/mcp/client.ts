// MCP servers reached with the official client: each list or call opens a connection, on the
// transport the server answered on before or else on Streamable HTTP falling back to HTTP+SSE, and
// closes it. On Streamable HTTP the client asks the server which revision it speaks, taking up the
// 2026-07-28 one where the server offers it and the older initialize handshake where it does not;
// a call to a server that answered with an older revision before goes straight to the handshake.
// Headers go only to the server's own origin. OAuth follows the MCP authorization spec through the
// client's own flow (discovery, client choice, PKCE, resource indicators, renewal), its state kept
// wherever the caller keeps it. The client Mage is with an authorization server is one people
// entered; else, where the server takes them and Mage is served over HTTPS, the address of Mage's
// client metadata document; else one the server registers. Whether an address answers as an MCP
// server is asked with a first initialize request of its own, and any JSON-RPC answer to it
// counts, even a refusal from a server that speaks only a later revision.

import {
  auth,
  Client,
  type FetchLike,
  isHttpsUrl,
  isJSONRPCErrorResponse,
  OAuthError,
  type OAuthClientProvider,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import type { McpTransport } from "@/shared/mcp.ts";
import type { ToolDefinition } from "@/shared/tools.ts";

import type { McpOAuthState } from "./service.ts";

// How a client authorizes itself with a server: not at all, with headers, or with OAuth state it
// reads and saves as the flow goes.
export type McpAuth =
  | { kind: "none" }
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "oauth"; state: McpOAuthStore };

export interface McpOAuthStore {
  load(): McpOAuthState;
  save(state: McpOAuthState): void;
}

export interface McpTarget {
  url: string;
  // The transport it answered on before, tried first; null tries Streamable HTTP, then HTTP+SSE.
  transport: McpTransport | null;
  // The revision it answered with before: an older one is spoken again without asking; null, or
  // the 2026-07-28 one, asks which it speaks.
  protocolVersion: string | null;
  auth: McpAuth;
}

export interface McpListing {
  transport: McpTransport;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  // What the server said about using its tools, as it said it; null when it said nothing.
  instructions: string | null;
  // Whether it declares resources the agent may list and read.
  resources: boolean;
  tools: ToolDefinition[];
  // The prompts it offers people as commands; none when it declares no prompts.
  prompts: McpPrompt[];
}

// A prompt a server offers: its name, what it says of it, and the arguments it takes in order.
export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required: boolean }[];
}

// What a prompt gave back: its messages, each one's role and content as MCP sends it.
export interface McpPromptResult {
  messages: { role: string; content: Record<string, unknown> }[];
}

// A resource a server lists: its address, name, and what it says of it.
export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

// One part of a read resource: text, or base64 bytes.
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// MCP's result of a tool call: its content, structured content where the tool gives some, and
// whether it is an error.
export interface McpCallResult {
  content: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// Why a server could not be reached: it needs authorizing (again), or it failed; and whether it
// refused the credentials it was sent.
export class McpError extends Error {
  readonly kind: "needs_auth" | "error";
  readonly refused: boolean;

  constructor(kind: McpError["kind"], message: string, refused = kind === "needs_auth") {
    super(message);
    this.kind = kind;
    this.refused = refused;
  }
}

// How an address answered a first MCP request: as an MCP server (or one asking for OAuth with
// protected-resource metadata), asking for other authorization, as something else, or not at all.
export type McpAnswer = "mcp" | "auth" | "other" | "unreachable";

// The OAuth client Mage is: its name and home page, where the authorization server sends people
// back, and where its client metadata document is published.
export interface McpOAuthClient {
  clientName: string;
  clientUri: string;
  redirectUrl: string;
  documentUrl: string;
}

// The OAuth client Mage is when served at the base URL.
export function mcpOAuthClientAt(baseUrl: string): McpOAuthClient {
  return {
    clientName: "Mage",
    clientUri: baseUrl,
    redirectUrl: `${baseUrl}/api/mcp/oauth/callback`,
    documentUrl: `${baseUrl}/api/mcp/oauth/client.json`,
  };
}

// What Mage says of itself as an OAuth client, when registering and in its metadata document: a
// public client that signs people in with a code and renews its tokens.
function clientMetadataOf(client: McpOAuthClient) {
  return {
    client_name: client.clientName,
    client_uri: client.clientUri,
    redirect_uris: [client.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

// Mage's client metadata document: the same for every request, its client_id its own address.
export function mcpClientDocument(client: McpOAuthClient) {
  return { client_id: client.documentUrl, ...clientMetadataOf(client) };
}

// The document's address, where authorization servers may fetch it: only an HTTPS one counts as a
// client_id, so Mage served over plain HTTP registers instead.
function documentUrlOf(client: McpOAuthClient) {
  return isHttpsUrl(client.documentUrl) ? client.documentUrl : undefined;
}

export interface McpClient {
  // Whether the address answers as an MCP server, sent with the headers given.
  probe(url: string, headers: Record<string, string>): Promise<McpAnswer>;
  // Throws McpError.
  list(target: McpTarget): Promise<McpListing>;
  call(
    target: McpTarget,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  // Every resource the server lists, all pages of them.
  listResources(target: McpTarget, signal?: AbortSignal): Promise<McpResource[]>;
  readResource(target: McpTarget, uri: string, signal?: AbortSignal): Promise<McpResourceContent[]>;
  getPrompt(
    target: McpTarget,
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpPromptResult>;
  // The client metadata document Mage publishes.
  clientDocument(): ReturnType<typeof mcpClientDocument>;
  // Starts authorizing Mage: the address to send the person to, with `state` and the PKCE
  // verifier kept in `pending`; or null when the tokens held are still good or were renewed.
  authorize(
    url: string,
    oauth: McpOAuthStore,
    state: string,
    pending: { value?: string },
  ): Promise<string | null>;
  // Finishes it with the code the authorization server sent back.
  finish(
    url: string,
    oauth: McpOAuthStore,
    verifier: string,
    callback: { code: string; iss?: string },
  ): Promise<void>;
}

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
  const documentUrl = documentUrlOf(client);
  return {
    get redirectUrl() {
      return client.redirectUrl;
    },
    get clientMetadata() {
      return clientMetadataOf(client);
    },
    ...(documentUrl && { clientMetadataUrl: documentUrl }),
    ...(flow.state && { state: () => flow.state! }),
    // A metadata document client is the document's address: one at another address, as when
    // Mage's base URL changed, is forgotten with the tokens issued to it, and a client chosen again.
    clientInformation() {
      const state = oauth.load();
      if (state.document && state.client?.client_id !== documentUrl) {
        update((stale) => {
          delete stale.client;
          delete stale.document;
          delete stale.tokens;
        });
        return undefined;
      }
      return state.client as never;
    },
    saveClientInformation: (info) =>
      update((state) => {
        state.client = { ...info };
        if (!state.manual && documentUrl && info.client_id === documentUrl) state.document = true;
        else delete state.document;
      }),
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
    // A client people entered is kept; any other is chosen again.
    invalidateCredentials: (scope) =>
      update((state) => {
        if (scope === "all" || scope === "tokens") delete state.tokens;
        if (scope === "all" || scope === "discovery") delete state.discovery;
        if ((scope === "all" || scope === "client") && !state.manual) {
          delete state.client;
          delete state.document;
        }
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
  // Asking which revision the server speaks failed for a reason of its own.
  if (err instanceof SdkError && err.code === SdkErrorCode.EraNegotiationFailed && err.cause) {
    return mcpFailure(err.cause, target);
  }
  const oauth = target.auth.kind === "oauth";
  const status = err instanceof SdkHttpError ? err.status : null;
  if (err instanceof UnauthorizedError || err instanceof OAuthError) {
    return new McpError(
      oauth ? "needs_auth" : "error",
      "The server needs Mage authorized again.",
      true,
    );
  }
  if (status === 401 || status === 403) {
    return oauth
      ? new McpError("needs_auth", "The server needs Mage authorized again.")
      : new McpError(
          "error",
          target.auth.kind === "headers"
            ? `The server did not accept the headers (HTTP ${status}).`
            : `The server needs authorization (HTTP ${status}).`,
          true,
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

// Whether a refused request's body is a JSON-RPC error, as only an MCP server would answer.
async function answeredJsonRpc(res: Response) {
  try {
    return isJSONRPCErrorResponse(JSON.parse(await res.text()));
  } catch {
    return false;
  }
}

// Whether a revision the server answered with before is one of the initialize handshake's.
function olderRevision(version: string | null) {
  return version !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(version);
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

// The prompts a server offers, all pages of them, when it declares prompts; a server that fails to
// list them offers none, so its tools are still read.
async function promptsOf(client: Client): Promise<McpPrompt[]> {
  if (!client.getServerCapabilities()?.prompts) return [];
  try {
    const { prompts } = await client.listPrompts();
    return prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.title && { title: prompt.title }),
      ...(prompt.description && { description: prompt.description }),
      arguments: (prompt.arguments ?? []).map((argument) => ({
        name: argument.name,
        ...(argument.description && { description: argument.description }),
        required: !!argument.required,
      })),
    }));
  } catch {
    return [];
  }
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const { fetch, oauth: oauthClient, version } = options;
  const document = mcpClientDocument(oauthClient);

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

  // A client connected on the transport. HTTP+SSE predates the 2026-07-28 revision, so it goes
  // straight to the initialize handshake.
  async function connectOn(kind: McpTransport, target: McpTarget) {
    const client = new Client(
      { name: oauthClient.clientName, version },
      kind === "sse" ? {} : { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(
      transportOf(kind, target.url, target.auth),
      olderRevision(target.protocolVersion) ? { prior: { kind: "legacy" } } : undefined,
    );
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
      let answer: McpAnswer = "other";
      if (res.ok) {
        await res.body?.cancel();
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
        await res.body?.cancel();
        const challenge = res.headers.get("www-authenticate") ?? "";
        answer =
          /resource_metadata=/i.test(challenge) || (await describesResource(address))
            ? "mcp"
            : "auth";
      } else if (res.status === 403) {
        await res.body?.cancel();
        answer = "auth";
      } else if (await answeredJsonRpc(res)) {
        answer = "mcp";
      }
      return answer;
    },

    // Asks the server again which revision it speaks, whatever it answered with before.
    list(target) {
      return using({ ...target, protocolVersion: null }, async (client, transport) => {
        const { tools } = await client.listTools();
        const info = client.getServerVersion();
        return {
          transport,
          protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
          serverInfo: info ? { name: info.name, version: info.version } : null,
          instructions: client.getInstructions() ?? null,
          resources: !!client.getServerCapabilities()?.resources,
          tools: tools.map(definitionOf),
          prompts: await promptsOf(client),
        };
      });
    },

    call(target, name, args, signal) {
      return using(target, async (client) => {
        const result = await client.callTool({ name, arguments: args }, { signal });
        return result as McpCallResult;
      });
    },

    // Without a cursor the SDK walks every page itself.
    listResources(target, signal) {
      return using(target, async (client) => {
        const { resources } = await client.listResources(undefined, { signal });
        return resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          ...(resource.title && { title: resource.title }),
          ...(resource.description && { description: resource.description }),
          ...(resource.mimeType && { mimeType: resource.mimeType }),
          ...(typeof resource.size === "number" && { size: resource.size }),
        }));
      });
    },

    readResource(target, uri, signal) {
      return using(target, async (client) => {
        const { contents } = await client.readResource({ uri }, { signal });
        return contents.map((part) => ({
          uri: part.uri,
          ...(part.mimeType && { mimeType: part.mimeType }),
          ...("text" in part && typeof part.text === "string" && { text: part.text }),
          ...("blob" in part && typeof part.blob === "string" && { blob: part.blob }),
        }));
      });
    },

    getPrompt(target, name, args, signal) {
      return using(target, async (client) => {
        const { messages } = await client.getPrompt({ name, arguments: args }, { signal });
        return {
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content as Record<string, unknown>,
          })),
        };
      });
    },

    clientDocument() {
      return document;
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
