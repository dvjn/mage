import { describe, expect, it } from "vite-plus/test";

import { mcpStandIn } from "../../../e2e/mcp-server.ts";
import {
  createMcpClient,
  mcpClientDocument,
  mcpOAuthClientAt,
  type McpOAuthClient,
  type McpOAuthStore,
} from "./client.ts";
import type { McpOAuthState } from "./service.ts";

const ORIGIN = "http://localhost:4791";
const SERVER = `${ORIGIN}/oauth/mcp`;

function memory(initial: McpOAuthState = {}) {
  let state = initial;
  return {
    get state(): McpOAuthState {
      return state;
    },
    load: (): McpOAuthState => structuredClone(state),
    save: (next: McpOAuthState) => void (state = structuredClone(next)),
  } satisfies McpOAuthStore & { state: McpOAuthState };
}

// A server behind OAuth whose authorization server knows the client mage-app, and takes Mage's
// metadata documents, at any of the base URLs, where it says it does.
function authorizationServer(options: { documents: boolean; bases?: string[] }) {
  const published = new Map(
    (options.bases ?? []).map((base) => {
      const client = mcpOAuthClientAt(base);
      return [client.documentUrl, mcpClientDocument(client)];
    }),
  );
  const fetched: string[] = [];
  const requests: Request[] = [];
  const handle = mcpStandIn({
    origin: ORIGIN,
    clients: [{ id: "mage-app" }],
    ...(options.documents && {
      clientDocuments: async (url: string) => {
        fetched.push(url);
        const document = published.get(url);
        return document ? Response.json(document) : new Response(null, { status: 404 });
      },
    }),
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handle(request);
  };
  return { handle, fetch, fetched, requests };
}

type Network = ReturnType<typeof authorizationServer>;

function mageAt(base: string, network: Network) {
  const oauth = mcpOAuthClientAt(base);
  return { oauth, client: createMcpClient({ fetch: network.fetch, oauth, version: "test" }) };
}

// Signs in as a person approving on the authorization server's page, and gives where it began.
async function signIn(mage: ReturnType<typeof mageAt>, network: Network, store: McpOAuthStore) {
  const pending: { value?: string } = {};
  const started = await mage.client.authorize(SERVER, store, "state", pending);
  const page = await network.handle(new Request(started!));
  const code = new URL(page.headers.get("location")!).searchParams.get("code")!;
  await mage.client.finish(SERVER, store, pending.value!, { code });
  return new URL(started!);
}

function registered(network: Network) {
  return network.requests.filter((req) => new URL(req.url).pathname === "/register");
}

describe("Mage's client metadata document", () => {
  it("names itself by its address, and says what registering says", async () => {
    const oauth: McpOAuthClient = mcpOAuthClientAt("https://mage.example");
    expect(mcpClientDocument(oauth)).toEqual({
      client_id: "https://mage.example/api/mcp/oauth/client.json",
      client_name: "Mage",
      client_uri: "https://mage.example",
      redirect_uris: ["https://mage.example/api/mcp/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    const network = authorizationServer({ documents: false });
    const mage = mageAt("https://mage.example", network);
    await signIn(mage, network, memory());
    const [registration] = registered(network);
    const { client_id: _, ...metadata } = mcpClientDocument(oauth);
    expect(await registration!.json()).toMatchObject(metadata);
  });

  it("is the client Mage is over HTTPS where the server takes documents", async () => {
    const network = authorizationServer({ documents: true, bases: ["https://mage.example"] });
    const mage = mageAt("https://mage.example", network);
    const store = memory();
    const started = await signIn(mage, network, store);

    expect(started.searchParams.get("client_id")).toBe(mage.oauth.documentUrl);
    expect(network.fetched).toEqual([mage.oauth.documentUrl]);
    expect(registered(network)).toEqual([]);
    expect(store.state).toMatchObject({
      client: { client_id: mage.oauth.documentUrl },
      document: true,
      tokens: { token_type: "Bearer" },
    });
    const listing = await mage.client.list({
      url: SERVER,
      transport: null,
      protocolVersion: null,
      auth: { kind: "oauth", state: store },
    });
    expect(listing.tools).toHaveLength(3);
  });

  it("is not used over plain HTTP, or where the server does not take documents", async () => {
    const plain = authorizationServer({ documents: true, bases: ["http://localhost:4783"] });
    const overHttp = memory();
    const started = await signIn(mageAt("http://localhost:4783", plain), plain, overHttp);
    expect(started.searchParams.get("client_id")).toMatch(/^client-/);
    expect(plain.fetched).toEqual([]);
    expect(overHttp.state.document).toBeUndefined();

    const older = authorizationServer({ documents: false });
    const store = memory();
    const registeredStart = await signIn(mageAt("https://mage.example", older), older, store);
    expect(registeredStart.searchParams.get("client_id")).toMatch(/^client-/);
    expect(registered(older)).toHaveLength(1);
  });

  it("gives way to a client people entered", async () => {
    const network = authorizationServer({ documents: true, bases: ["https://mage.example"] });
    const store = memory({ client: { client_id: "mage-app" }, manual: true });
    const started = await signIn(mageAt("https://mage.example", network), network, store);
    expect(started.searchParams.get("client_id")).toBe("mage-app");
    expect(network.fetched).toEqual([]);
    expect(store.state).toMatchObject({ client: { client_id: "mage-app" }, manual: true });
    expect(store.state.document).toBeUndefined();
  });

  it("is chosen again, with new tokens, once Mage's base URL changes", async () => {
    const network = authorizationServer({
      documents: true,
      bases: ["https://mage.example", "https://mage.example.org"],
    });
    const store = memory();
    await signIn(mageAt("https://mage.example", network), network, store);

    const moved = mageAt("https://mage.example.org", network);
    const pending: { value?: string } = {};
    const started = new URL((await moved.client.authorize(SERVER, store, "state", pending))!);
    expect(started.searchParams.get("client_id")).toBe(moved.oauth.documentUrl);
    expect(store.state.tokens).toBeUndefined();
    expect(store.state.client).toMatchObject({ client_id: moved.oauth.documentUrl });

    // Served over plain HTTP again, Mage registers.
    const plain = mageAt("http://localhost:4783", network);
    const again = await signIn(plain, network, store);
    expect(again.searchParams.get("client_id")).toMatch(/^client-/);
    expect(store.state.document).toBeUndefined();
  });
});
