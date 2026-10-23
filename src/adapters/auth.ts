// Email and password accounts with cookie sessions, served under /api/auth. Password sign-in is
// open to everyone (the default), to the operators alone with no password sign-up, or to nobody.
// Every user gets a personal org with its first space at sign-up, and new sessions act in it. Orgs
// and their members are changed only through Mage's own API, so the library's org routes are off.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { OrgRole } from "@/ports/directory.ts";
import type { Identity, Principal } from "@/ports/identity.ts";
import type { Logger } from "@/ports/logger.ts";
import { FIRST_SPACE_NAME } from "@/shared/spaces.ts";

import type { Db } from "./db.ts";
import * as schema from "./schema.ts";
import { createSpaceStore } from "./spaces.ts";

export interface AuthOptions {
  db: Db;
  logger: Logger;
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  passwordSignIn?: "everyone" | "operator" | "off";
  // The operators' lower-cased emails.
  operatorEmails?: string[];
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(options: AuthOptions) {
  const { db, passwordSignIn = "everyone", operatorEmails = [] } = options;
  const spaces = createSpaceStore(db);

  function personalOrgOf(userId: string) {
    return db
      .select({ id: schema.organization.id })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(and(eq(schema.member.userId, userId), eq(schema.organization.kind, "personal")))
      .get();
  }

  function hasMembers(orgId: string) {
    return !!db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, orgId))
      .get();
  }

  function rejectPersonal(org: Record<string, unknown>, message: string) {
    if (org.kind === "personal") throw new APIError("FORBIDDEN", { message });
  }

  const orgs = organization({
    allowUserToCreateOrganization: false,
    // Team orgs have no member limit.
    membershipLimit: Number.MAX_SAFE_INTEGER,
    schema: {
      organization: {
        additionalFields: {
          kind: { type: ["personal", "team"], required: true, input: true },
        },
      },
    },
    organizationHooks: {
      // Orgs made for sign-ups are personal; Mage names team orgs as such.
      beforeCreateOrganization: async ({ organization }) => ({
        data: { ...organization, kind: organization.kind === "team" ? "team" : "personal" },
      }),
      // A personal org has its owner and no one else.
      beforeAddMember: async ({ organization }) => {
        if (hasMembers(organization.id)) {
          rejectPersonal(organization, "A personal organization has no other members");
        }
      },
      beforeCreateInvitation: async ({ organization }) => {
        rejectPersonal(organization, "A personal organization cannot invite members");
      },
    },
  });

  const auth = betterAuth({
    // Every setting the library would otherwise take from BETTER_AUTH_* env vars is set here.
    baseURL: options.baseUrl,
    basePath: "/api/auth",
    secret: options.secret,
    secrets: [{ version: 1, value: options.secret }],
    trustedOrigins: [options.baseUrl, ...options.trustedOrigins],
    telemetry: { enabled: false, debug: false },
    advanced: { cookiePrefix: "mage", disableOriginCheck: false, disableCSRFCheck: false },
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: passwordSignIn !== "off",
      disableSignUp: passwordSignIn !== "everyone",
    },
    hooks: {
      // Someone other than an operator is told what a wrong password tells them, so the operators'
      // emails stay unknown.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email" || passwordSignIn !== "operator") return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email === "string" && operatorEmails.includes(email.toLowerCase())) {
          return;
        }
        throw new APIError("UNAUTHORIZED", {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
        });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user): Promise<void> => {
            const org = await auth.api.createOrganization({
              body: { name: user.name, slug: user.id, userId: user.id, kind: "personal" },
            });
            spaces.create({
              orgId: org.id,
              kind: "personal",
              name: FIRST_SPACE_NAME,
              primary: true,
              createdBy: user.id,
            });
            // Sign-up opens its session before this runs, so that session is pointed at the org here.
            db.update(schema.session)
              .set({ activeOrganizationId: org.id })
              .where(
                and(
                  eq(schema.session.userId, user.id),
                  isNull(schema.session.activeOrganizationId),
                ),
              )
              .run();
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (session.activeOrganizationId) return;
            const org = personalOrgOf(session.userId);
            if (!org) return;
            return { data: { ...session, activeOrganizationId: org.id } };
          },
        },
      },
    },
    plugins: [orgs],
    disabledPaths: Object.values(orgs.endpoints).map((endpoint) => endpoint.path),
    logger: {
      log: (level, message, ...args) => options.logger[level](args.length ? { args } : {}, message),
    },
  });
  return auth;
}

// Reads the signed-in user from the session cookie, and their member row in the org the request
// names, or else in the org they used last, or else their personal one. Naming another org makes it
// the one used last.
export function createIdentity(auth: Auth, db: Db): Identity {
  function roleIn(userId: string, orgId: string) {
    const member = db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, orgId)))
      .get();
    return member ? (member.role as OrgRole) : null;
  }

  function personalOrgOf(userId: string) {
    return db
      .select({ id: schema.organization.id })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(and(eq(schema.member.userId, userId), eq(schema.organization.kind, "personal")))
      .get()?.id;
  }

  return {
    async resolve(headers, orgId) {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      const userId = result.user.id;
      const signedIn = { userId, email: result.user.email };
      const last = result.session.activeOrganizationId;
      if (orgId) {
        const role = roleIn(userId, orgId);
        if (!role) return { ...signedIn, principal: null };
        if (orgId !== last) {
          db.update(schema.session)
            .set({ activeOrganizationId: orgId })
            .where(eq(schema.session.id, result.session.id))
            .run();
        }
        return { ...signedIn, principal: { userId, orgId, role } };
      }
      for (const candidate of [last, personalOrgOf(userId)]) {
        const role = candidate ? roleIn(userId, candidate) : null;
        if (candidate && role)
          return { ...signedIn, principal: { userId, orgId: candidate, role } };
      }
      return { ...signedIn, principal: null };
    },

    async profile(principal: Principal) {
      const row = db
        .select({
          user: { id: schema.user.id, name: schema.user.name, email: schema.user.email },
          org: {
            id: schema.organization.id,
            name: schema.organization.name,
            kind: schema.organization.kind,
          },
        })
        .from(schema.user)
        .innerJoin(schema.organization, eq(schema.organization.id, principal.orgId))
        .where(eq(schema.user.id, principal.userId))
        .get();
      if (!row) throw new Error("principal has no user or org");
      const owner = db
        .select({ name: schema.user.name })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(
          and(eq(schema.member.organizationId, principal.orgId), eq(schema.member.role, "owner")),
        )
        .orderBy(asc(schema.member.createdAt))
        .get();
      return {
        ...row,
        org: { ...row.org, ownerName: owner?.name ?? null },
        role: principal.role,
      };
    },
  };
}
