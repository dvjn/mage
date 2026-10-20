// Email and password accounts with cookie sessions, served under /api/auth.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

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

export function createAuth(options: AuthOptions) {
  return betterAuth({
    // Every setting the library would otherwise take from BETTER_AUTH_* env vars is set here.
    baseURL: options.baseUrl,
    basePath: "/api/auth",
    secret: options.secret,
    secrets: [{ version: 1, value: options.secret }],
    trustedOrigins: [options.baseUrl, ...options.trustedOrigins],
    telemetry: { enabled: false, debug: false },
    advanced: { cookiePrefix: "mage", disableOriginCheck: false, disableCSRFCheck: false },
    database: drizzleAdapter(options.db, { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true },
    logger: {
      log: (level, message, ...args) => options.logger[level](args.length ? { args } : {}, message),
    },
  });
}
