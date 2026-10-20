// A signed-up app with real spaces and threads over an in-memory database, for the tests of
// spaces, threads and their events.

import { eq } from "drizzle-orm";
import { expect } from "vite-plus/test";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import * as schema from "@/adapters/schema.ts";
import { createSpaceStore } from "@/adapters/spaces.ts";
import { createThreadStore } from "@/adapters/threads.ts";
import { createApp } from "@/http/app.ts";
import type { Connections } from "@/services/connections.ts";
import type { Models } from "@/services/models.ts";
import { ServiceError } from "@/services/errors.ts";
import { createSpaces } from "@/services/spaces.ts";
import { createThreads } from "@/services/threads.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;
const unusedModels = {} as Models;

const baseUrl = "http://localhost:4783";

export type SpaceBody = { id: string; name: string; primary: boolean; role: string; kind: string };
export type ThreadBody = { id: string; spaceId: string; title: string; model: string | null };

export function setup() {
  const db = openDatabase(":memory:");
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
  const spaceStore = createSpaceStore(db);
  const threadStore = createThreadStore(db);
  const spaces = createSpaces({ spaces: spaceStore, threads: threadStore });
  // The models the org can use, and its default.
  const org = { defaultModel: null as string | null, models: ["codex/gpt-big"] };
  const models = {
    defaultModel: () => org.defaultModel,
    requireModel: (_orgId: string, ref: string) =>
      org.models.includes(ref)
        ? Promise.resolve()
        : Promise.reject(new ServiceError(400, `${ref} is not a model this org can use.`)),
  };
  const threads = createThreads({ spaces, threads: threadStore, models });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections: unusedConnections,
    models: { ...unusedModels, ...models },
    spaces,
    threads,
    logger,
    pingDatabase: () => Promise.resolve(true),
  });

  async function signUp(name: string, email: string) {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ name, email, password: "correct horse battery" }),
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    const cookie = res.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const member = db.select().from(schema.member).where(eq(schema.member.userId, user.id)).get();
    return { userId: user.id, orgId: member?.organizationId as string, role: "owner", cookie };
  }

  async function api(method: string, path: string, cookie: string, body?: object) {
    return app.request(`/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body && JSON.stringify(body),
    });
  }

  async function listSpaces(cookie: string) {
    const res = await api("GET", "/spaces", cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as SpaceBody[];
  }

  async function createSpace(cookie: string, name: string) {
    const res = await api("POST", "/spaces", cookie, { name });
    expect(res.status).toBe(200);
    return (await res.json()) as SpaceBody;
  }

  async function yourSpace(cookie: string) {
    const [space] = await listSpaces(cookie);
    if (!space) throw new Error("no space");
    return space;
  }

  async function createThread(cookie: string, spaceId: string, text?: string) {
    const res = await api("POST", `/spaces/${spaceId}/threads`, cookie, text ? { text } : {});
    expect(res.status).toBe(200);
    return (await res.json()) as ThreadBody;
  }

  return {
    db,
    app,
    org,
    spaceStore,
    threadStore,
    spaces,
    threads,
    signUp,
    api,
    listSpaces,
    createSpace,
    yourSpace,
    createThread,
  };
}
