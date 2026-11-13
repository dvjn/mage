// Serves the stand-ins for the systems Mage talks to, each on a port of its own, as one config file
// says: an identity provider with the directory it pushes, a model provider over each wire
// protocol, MCP servers and a git host of skills. A section left out is not served. `${NAME}` in the
// file is read from the environment, `${NAME:-default}` falling back to the default. Every port
// answers GET /_mock/health once all of them listen.

import { readFileSync, rmSync } from "node:fs";

import { serve } from "@hono/node-server";
import { parse } from "yaml";

import { type DirectoryGroup, pushDirectory, scimClient } from "./directory.ts";
import { createFixtures, gitStandIn } from "./git.ts";
import { identityStandIn } from "./identity.ts";
import { type McpStandInOptions, mcpStandIn } from "./mcp.ts";
import { type ListedModel, modelsStandIn } from "./models/models.ts";

interface Config {
  // Where its ports listen; every address unless given.
  host?: string;
  // The people the identity provider lists and the directory pushes.
  people?: { userName: string; name: string; email: string }[];
  identity?: {
    port: number;
    issuer?: string;
    title?: string;
    anyone?: boolean;
    clients: { id: string; secret: string; redirect: string }[];
  };
  // Mage's address and the directory's token there, and the groups it pushes.
  directory?: { mage: string; token: string; groups?: DirectoryGroup[] };
  models?: { port: number; pieceMs?: number; lists: Record<string, ListedModel[]> };
  mcp?: ({ port: number } & Partial<McpStandInOptions>)[];
  git?: { port: number };
}

type Handler = (req: Request) => Response | Promise<Response>;

// The file's text with each ${NAME} or ${NAME:-default} filled in.
function expand(text: string) {
  return text.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const value = process.env[name];
    if (value) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is not set`);
  });
}

const path = process.argv[2];
if (!path) throw new Error("usage: node mock/main.ts <config.yaml>");
const config = parse(expand(readFileSync(path, "utf8"))) as Config;
const host = config.host;
const local = (port: number) => `http://localhost:${port}`;

const cleanups: (() => void)[] = [];
const listeners: [string, number, Handler][] = [];

if (config.identity) {
  const { port, ...identity } = config.identity;
  listeners.push([
    "identity",
    port,
    await identityStandIn({
      ...identity,
      issuer: identity.issuer ?? local(port),
      people: config.people,
    }),
  ]);
}
if (config.models) {
  const { port, ...models } = config.models;
  listeners.push(["models", port, modelsStandIn(models)]);
}
for (const { port, ...options } of config.mcp ?? []) {
  listeners.push(["mcp", port, mcpStandIn({ ...options, origin: options.origin ?? local(port) })]);
}
if (config.git) {
  const root = createFixtures();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  listeners.push(["git", config.git.port, gitStandIn(root)]);
}

let ready = false;
function logged(name: string, handle: Handler): Handler {
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/_mock/health") return new Response(null, { status: ready ? 200 : 503 });
    const res = await handle(req);
    console.log(`${name} ${req.method} ${url.pathname} ${res.status}`);
    return res;
  };
}

await Promise.all(
  listeners.map(
    ([name, port, handle]) =>
      new Promise<void>((resolve) => {
        const server = serve({ fetch: logged(name, handle), port, hostname: host }, () => {
          console.log(`${name} on ${host ?? "*"}:${port}`);
          resolve();
        });
        cleanups.push(() => server.close());
      }),
  ),
);
ready = true;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const cleanup of cleanups) cleanup();
    process.exit(0);
  });
}

// The directory is pushed once Mage answers, as an identity provider pushes it when connected.
if (config.directory) {
  const { mage, token, groups = [] } = config.directory;
  const client = scimClient({ baseUrl: mage, token });
  for (;;) {
    try {
      await pushDirectory(client, config.people ?? [], groups);
      console.log(`directory pushed to ${mage}`);
      break;
    } catch (err) {
      console.log(`directory not pushed yet: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
