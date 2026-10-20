// Email and password accounts with cookie sessions, served under /api/auth.
// Every user gets a personal org at sign-up, and new sessions act in it.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { and, eq, isNull } from "drizzle-orm";

import type { Identity, Principal } from "@/ports/identity.ts";
import type { Logger } from "@/ports/logger.ts";

import type { Db } from "./db.ts";
import * as schema from "./schema.ts";

export interface AuthOptions {
  db: Db;
  logger: Logger;
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(options: AuthOptions) {
  const { db } = options;

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
    emailAndPassword: { enabled: true },
    databaseHooks: {
      user: {
        create: {
          after: async (user): Promise<void> => {
            const org = await auth.api.createOrganization({
              body: { name: user.name, slug: user.id, userId: user.id },
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
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        schema: {
          organization: {
            additionalFields: {
              kind: { type: ["personal", "team"], required: true, input: false },
            },
          },
        },
        organizationHooks: {
          // Orgs are only created for sign-ups, so every new org is a personal one.
          beforeCreateOrganization: async ({ organization }) => ({
            data: { ...organization, kind: "personal" },
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
      }),
    ],
    logger: {
      log: (level, message, ...args) => options.logger[level](args.length ? { args } : {}, message),
    },
  });
  return auth;
}

// Reads the principal from the session cookie and the member row for its active org.
export function createIdentity(auth: Auth, db: Db): Identity {
  return {
    async resolve(headers) {
      const result = await auth.api.getSession({ headers });
      const orgId = result?.session.activeOrganizationId;
      if (!result || !orgId) return null;
      const member = db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(
          and(eq(schema.member.userId, result.user.id), eq(schema.member.organizationId, orgId)),
        )
        .get();
      return member ? { userId: result.user.id, orgId, role: member.role } : null;
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
      return { ...row, role: principal.role };
    },
  };
}
