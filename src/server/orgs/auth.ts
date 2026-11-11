// Accounts with cookie sessions, served under /api/auth. People sign in and up with an email and a
// password, or, with an OpenID Connect provider, only there: a returning person by their subject at
// the provider, someone new to it by their email, joining an account they already have, password
// or not, or else getting a new one.
// Every user gets a personal org at sign-up, announced so other features can add to it, and new
// sessions act in it. Orgs and their members are changed only through Mage's own API, so the
// library's org routes are off.
// With a SCIM token, a directory provisions people and groups under /api/auth/scim/v2: someone it
// brings who already has an account by that email is linked to it, each change to a person or their
// groups is passed on to settle their org access, and someone it turns off or deletes cannot sign in.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { genericOAuth, organization } from "better-auth/plugins";
import { scim } from "@better-auth/scim";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Hooks } from "@/server/kernel/hooks.ts";
import type { Logger } from "@/server/kernel/logger.ts";
import { type Db, withAsyncTransactions } from "@/server/db/db.ts";

import { keepGroupEmails } from "./group-email.ts";
import type { OrgRole } from "./directory.ts";
import type { Identity, Principal } from "./identity.ts";
import * as schema from "./schema.ts";

export interface AuthOptions {
  db: Db;
  logger: Logger;
  secret: string;
  baseUrl: string;
  trustedOrigins: string[];
  oidc?: { issuer: string; clientId: string; clientSecret: string } | null;
  // The bearer token a SCIM directory provisions with, and what to tell when the directory changed
  // a person or the groups they are in; `active` is false once it turned them off or deleted them.
  scim?: { token: string; changed: (userId: string, active: boolean) => Promise<void> } | null;
  hooks?: Hooks;
}

declare module "@/server/kernel/hooks.ts" {
  interface HookEvents {
    // Someone new has an account and their personal org; their session acts in it once this ends.
    "person.signedUp": { userId: string; orgId: string };
  }
}

// The one SCIM connection, the server's directory.
export const SCIM_CONNECTION = "directory";

// The id people sign in with the OpenID Connect provider under, in the callback's path too.
export const OIDC_PROVIDER = "oidc";

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(options: AuthOptions) {
  const { db, oidc, scim: directory } = options;

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

  function userIdByEmail(email: string) {
    return db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(sql`lower(${schema.user.email})`, email.toLowerCase()))
      .get()?.id;
  }

  // The directory brought them and no longer has them active.
  function turnedOff(userId: string) {
    return !!db.get(sql`
      select 1 from scim_subject s
       where s.user_id = ${userId}
         and not exists (select 1 from scim_user u where u.user_id = s.user_id and u.active = 1)`);
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
    database: drizzleAdapter(withAsyncTransactions(db), {
      provider: "sqlite",
      schema,
      transaction: true,
    }),
    account: {
      // The operator chose the provider, so the email it gives is trusted to join an account that
      // has it, though Mage never verified that account's email.
      accountLinking: { trustedProviders: [OIDC_PROVIDER], requireLocalEmailVerified: false },
    },
    // Passwords are the way in only while there is no identity provider.
    emailAndPassword: { enabled: !oidc },
    databaseHooks: {
      user: {
        create: {
          after: async (user): Promise<void> => {
            const org = await auth.api.createOrganization({
              body: { name: user.name, slug: user.id, userId: user.id, kind: "personal" },
            });
            db.update(schema.member)
              .set({ directRole: "owner" })
              .where(eq(schema.member.organizationId, org.id))
              .run();
            await options.hooks?.run("person.signedUp", { userId: user.id, orgId: org.id });
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
            if (turnedOff(session.userId)) {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_TURNED_OFF",
                message: "Your account was turned off in your organization's directory",
              });
            }
            if (session.activeOrganizationId) return;
            const org = personalOrgOf(session.userId);
            if (!org) return;
            return { data: { ...session, activeOrganizationId: org.id } };
          },
        },
      },
    },
    plugins: [
      orgs,
      genericOAuth({
        config: oidc
          ? [
              {
                providerId: OIDC_PROVIDER,
                discoveryUrl: `${oidc.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                scopes: ["openid", "email", "profile"],
                // A provider that gives no name has the person go by their email.
                mapProfileToUser: (profile) => ({ name: profile.name || profile.email || "" }),
              },
            ]
          : [],
      }),
      ...(directory
        ? [
            scim({
              connections: [
                {
                  id: SCIM_CONNECTION,
                  credentials: [{ type: "bearer", id: "token", token: directory.token }],
                },
              ],
              identity: {
                // The operator connected the directory, so the email it gives is trusted to join the
                // account that has it, which it manages from then on.
                resolveUser: ({ resource }) => {
                  const userId = userIdByEmail(resource.primaryEmail);
                  return userId
                    ? { action: "link", userId, profile: "manage" }
                    : { action: "create" };
                },
              },
              projection: {
                reconcileUser: async ({ userId, active }) => {
                  if (!active) {
                    db.delete(schema.session).where(eq(schema.session.userId, userId)).run();
                  }
                  await directory.changed(userId, active);
                },
              },
            }),
          ]
        : []),
    ],
    disabledPaths: Object.values(orgs.endpoints).map((endpoint) => endpoint.path),
    logger: {
      log: (level, message, ...args) => options.logger[level](args.length ? { args } : {}, message),
    },
  });
  return directory ? { ...auth, handler: keepGroupEmails(db, auth.handler) } : auth;
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
