import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import * as schema from "@/adapters/schema.ts";
import { createSpaceStore } from "@/adapters/spaces.ts";
import { createApp } from "@/http/app.ts";
import type { Connections } from "@/services/connections.ts";
import type { Models } from "@/services/models.ts";
import { createSpaces } from "@/services/spaces.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;
const unusedModels = {} as Models;

const baseUrl = "http://localhost:4783";

type SpaceBody = { id: string; name: string; primary: boolean; role: string; kind: string };

function setup() {
  const db = openDatabase(":memory:");
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
  const store = createSpaceStore(db);
  const spaces = createSpaces({ spaces: store });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections: unusedConnections,
    models: unusedModels,
    spaces,
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

  function api(method: string, path: string, cookie: string, body?: object) {
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

  return { db, store, spaces, signUp, api, listSpaces, createSpace };
}

describe("spaces", () => {
  it("starts every personal org with Your space, owned by the user", async () => {
    const { db, signUp, listSpaces } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");

    expect(await listSpaces(cookie)).toEqual([
      expect.objectContaining({
        name: "Your space",
        kind: "personal",
        primary: true,
        role: "owner",
      }),
    ]);
    expect(db.select().from(schema.spaceMember).all()).toEqual([
      expect.objectContaining({ userId, role: "owner", source: "direct" }),
    ]);
  });

  it("creates, renames and deletes more spaces", async () => {
    const { api, signUp, listSpaces, createSpace } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const work = await createSpace(cookie, "  Work  ");
    expect(work).toMatchObject({ name: "Work", primary: false, role: "owner" });

    const renamed = await api("PATCH", `/spaces/${work.id}`, cookie, { name: "Research" });
    expect(renamed.status).toBe(200);
    expect((await listSpaces(cookie)).map((space) => space.name)).toEqual([
      "Your space",
      "Research",
    ]);

    expect((await api("DELETE", `/spaces/${work.id}`, cookie)).status).toBe(200);
    expect((await listSpaces(cookie)).map((space) => space.name)).toEqual(["Your space"]);
  });

  it("renames Your space but does not delete it", async () => {
    const { api, signUp, listSpaces } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const [yours] = await listSpaces(cookie);

    expect((await api("PATCH", `/spaces/${yours?.id}`, cookie, { name: "Home" })).status).toBe(200);
    expect((await api("DELETE", `/spaces/${yours?.id}`, cookie)).status).toBe(409);
    expect(await listSpaces(cookie)).toEqual([expect.objectContaining({ name: "Home" })]);
  });

  it("needs a name of 1 to 80 characters", async () => {
    const { api, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    for (const name of ["", "   ", "x".repeat(81)]) {
      expect((await api("POST", "/spaces", cookie, { name })).status).toBe(400);
    }
  });

  it("does not show another org's spaces and answers 404 for them", async () => {
    const { api, signUp, listSpaces, createSpace } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const work = await createSpace(ada.cookie, "Work");

    expect((await listSpaces(grace.cookie)).map((space) => space.name)).toEqual(["Your space"]);
    expect((await api("PATCH", `/spaces/${work.id}`, grace.cookie, { name: "Mine" })).status).toBe(
      404,
    );
    expect((await api("DELETE", `/spaces/${work.id}`, grace.cookie)).status).toBe(404);
    expect((await api("DELETE", "/spaces/no-such-space", grace.cookie)).status).toBe(404);
  });

  it("is unauthorized when signed out", async () => {
    const { api } = setup();

    expect((await api("GET", "/spaces", "")).status).toBe(401);
    expect((await api("POST", "/spaces", "", { name: "Work" })).status).toBe(401);
  });
});

describe("canSee", () => {
  it("is true only for members in the space's own org", async () => {
    const { store, spaces, signUp } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const space = store.create({
      orgId: ada.orgId,
      kind: "personal",
      name: "Work",
      createdBy: ada.userId,
    });

    expect(spaces.canSee(ada, space)).toBe(true);
    // A member acting in another org.
    expect(spaces.canSee({ ...ada, orgId: grace.orgId }, space)).toBe(false);
    // Someone in the org who is not a member.
    expect(spaces.canSee({ ...grace, orgId: ada.orgId }, space)).toBe(false);
    expect(spaces.canSee(grace, space)).toBe(false);
  });
});
