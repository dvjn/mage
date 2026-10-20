import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { createAuth, createIdentity } from "@/adapters/auth.ts";
import { openDatabase } from "@/adapters/db.ts";
import { createLogger } from "@/adapters/logger.ts";
import * as schema from "@/adapters/schema.ts";
import { createApp } from "@/http/app.ts";
import type { Connections } from "@/services/connections.ts";

// Never called by these tests.
const unusedConnections = {} as Connections;

const baseUrl = "http://localhost:4783";

function setup() {
  const db = openDatabase(":memory:");
  const logger = createLogger({ write() {} });
  const secret = "test-secret-that-is-long-enough-1234567890";
  const auth = createAuth({ db, logger, secret, baseUrl, trustedOrigins: [] });
  const app = createApp({
    handleAuth: auth.handler,
    identity: createIdentity(auth, db),
    connections: unusedConnections,
    logger,
    pingDatabase: () => Promise.resolve(true),
  });

  function post(path: string, body: object, cookie = "") {
    return app.request(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, Cookie: cookie },
      body: JSON.stringify(body),
    });
  }

  async function signUp(name: string, email: string) {
    const res = await post("/sign-up/email", { name, email, password: "correct horse battery" });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    const cookie = res.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { userId: user.id, cookie };
  }

  return { db, auth, app, post, signUp };
}

describe("personal organization", () => {
  it("is created at sign-up with the user as owner and is the session's active org", async () => {
    const { db, signUp } = setup();
    const { userId } = await signUp("Ada Lovelace", "ada@example.com");

    const orgs = db.select().from(schema.organization).all();
    expect(orgs).toEqual([expect.objectContaining({ name: "Ada Lovelace", kind: "personal" })]);
    expect(db.select().from(schema.member).all()).toEqual([
      expect.objectContaining({ organizationId: orgs[0]?.id, userId, role: "owner" }),
    ]);
    expect(db.select().from(schema.session).where(eq(schema.session.userId, userId)).all()).toEqual(
      [expect.objectContaining({ activeOrganizationId: orgs[0]?.id })],
    );
  });

  it("is the active org of later sign-ins", async () => {
    const { db, post, signUp } = setup();
    const { userId } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await post("/sign-in/email", {
      email: "ada@example.com",
      password: "correct horse battery",
    });

    expect(res.status).toBe(200);
    const [org] = db.select().from(schema.organization).all();
    const sessions = db.select().from(schema.session).where(eq(schema.session.userId, userId));
    expect(sessions.all().map((session) => session.activeOrganizationId)).toEqual([
      org?.id,
      org?.id,
    ]);
  });

  it("rejects invitations", async () => {
    const { post, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await post(
      "/organization/invite-member",
      { email: "grace@example.com", role: "member" },
      cookie,
    );

    expect(res.status).toBe(403);
  });

  it("rejects adding a member", async () => {
    const { db, auth, signUp } = setup();
    await signUp("Ada Lovelace", "ada@example.com");
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const ada = db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.name, "Ada Lovelace"))
      .get();

    await expect(
      auth.api.addMember({
        body: { userId: grace.userId, role: "member", organizationId: ada?.id ?? "" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects creating another org through the API", async () => {
    const { db, post, signUp } = setup();
    const { cookie } = await signUp("Ada Lovelace", "ada@example.com");

    const res = await post("/organization/create", { name: "Acme", slug: "acme" }, cookie);

    expect(res.status).toBe(403);
    expect(db.select().from(schema.organization).all()).toHaveLength(1);
  });
});

describe("GET /api/v1/me", () => {
  it("is unauthorized when signed out", async () => {
    const { app } = setup();
    const res = await app.request("/api/v1/me");
    expect(res.status).toBe(401);
  });

  it("returns the user, their personal org and their role", async () => {
    const { app, db, signUp } = setup();
    const { userId, cookie } = await signUp("Ada Lovelace", "ada@example.com");
    const [org] = db.select().from(schema.organization).all();

    const res = await app.request("/api/v1/me", { headers: { Cookie: cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: userId, name: "Ada Lovelace", email: "ada@example.com" },
      org: { id: org?.id, name: "Ada Lovelace", kind: "personal" },
      role: "owner",
    });
  });
});
