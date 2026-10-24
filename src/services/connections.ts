// An org's connections: made by signing in to a provider account the way the provider's own
// coding app does, with a device code or a browser authorization whose result the user pastes
// back, kept usable by renewing their tokens, or by adding a key, cloud credentials or a server's
// address for a host, and optionally sending their requests through a proxy, kept sealed with the
// tokens or the secrets.

import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import * as z from "zod";

import type { Connection, ConnectionStore } from "@/ports/connections.ts";
import type { CredentialStore } from "@/ports/credentials.ts";
import type { Logger } from "@/ports/logger.ts";
import type { ProviderProxy } from "@/ports/model-gateway.ts";
import type { BrowserOAuth, DeviceCode, DeviceOAuth, OAuthTokens } from "@/ports/oauth.ts";
import type { SignInAttemptStore } from "@/ports/sign-in-attempts.ts";
import type { ProxyInput, ProxySummary } from "@/shared/connections.ts";
import type { AuthKind, HostId } from "@/shared/hosts.ts";

// The hosts signed in to with a subscription.
export type AccountKind = "codex";

export class ConnectionError extends Error {
  readonly status: 400 | 404 | 409 | 502;

  constructor(status: ConnectionError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

// The org's owner acting on its connections.
export interface Owner {
  orgId: string;
  userId: string;
}

export interface AccountProvider {
  // How people know the sign-in, as in "Sign in with Codex".
  label: string;
  browser: BrowserOAuth;
  device?: DeviceOAuth;
}

export interface ConnectionsOptions {
  connections: ConnectionStore;
  credentials: CredentialStore;
  attempts: SignInAttemptStore;
  providers: Record<AccountKind, AccountProvider>;
  logger: Logger;
  now?: () => Date;
  // Waits between device code polls; rejects when the signal aborts.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type Connections = ReturnType<typeof createConnections>;

export type AttemptStatus =
  | { status: "pending" }
  | { status: "connected"; connection: Connection }
  | { status: "failed"; error: string };

// A connection to add for a host, with what is not secret about it apart from its secrets.
export interface NewHostConnection {
  host: HostId;
  authKind: Exclude<AuthKind, "oauth">;
  label: string | null;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  proxy?: ProviderProxy | null;
}

export interface FreshToken {
  access: string;
  accountId: string | null;
  proxy: ProviderProxy | null;
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
}

const BROWSER_TTL_MS = 10 * 60 * 1000;
const DEVICE_TTL_MS = 15 * 60 * 1000;
// How long a finished device sign-in stays readable.
const DEVICE_KEEP_MS = 5 * 60 * 1000;
const MIN_POLL_MS = 1000;
const SLOW_DOWN_MS = 5000;
// Tokens this close to expiring are renewed before use.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const proxySchema = z.object({
  baseUrl: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
});

const credentialSchema = z.object({
  access: z.string(),
  refresh: z.string(),
  expires: z.number(),
  accountId: z.string().optional(),
  email: z.string().optional(),
  plan: z.string().optional(),
  proxy: proxySchema.optional(),
});

// A key, cloud credentials or a server's optional key, and the proxy.
const secretsCredentialSchema = z.object({
  apiKey: z.string().optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  proxy: proxySchema.optional(),
});

// Whatever a connection keeps, read only for its proxy.
const anyCredentialSchema = z.looseObject({ proxy: proxySchema.optional() });

type AccountCredential = z.infer<typeof credentialSchema>;

interface DeviceAttempt {
  id: string;
  kind: AccountKind;
  orgId: string;
  userId: string;
  expiresAt: Date;
  controller: AbortController;
  result: AttemptStatus;
}

function randomValue() {
  return randomBytes(32).toString("base64url");
}

// A key as people may see it again: its prefix and last four characters, as `sk-ant-…abcd`.
export function keyHint(key: string) {
  const prefix = /^[a-z]+[-_](?:[a-z]+[-_])?/i.exec(key)?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}

// What tells a connection's credentials apart, as people may see it: the server's address, a key's
// hint, the role, an access key's first and last characters, the service account, or the app.
export function accountOf(settings: Record<string, string>, secrets: Record<string, string>) {
  if (settings.baseUrl) return URL.parse(settings.baseUrl)?.host ?? settings.baseUrl;
  if (secrets.apiKey) return keyHint(secrets.apiKey);
  if (settings.roleArn) return settings.roleArn;
  if (secrets.accessKeyId)
    return `${secrets.accessKeyId.slice(0, 4)}…${secrets.accessKeyId.slice(-4)}`;
  if (secrets.serviceAccount) {
    const parsed = z
      .object({ client_email: z.string() })
      .safeParse(JSON.parse(secrets.serviceAccount));
    return parsed.success ? parsed.data.client_email : "Service account";
  }
  if (settings.clientId) return settings.clientId;
  return "—";
}

// The code and state in what the user pasted: the callback address, its query, `code#state` or
// the bare code.
function parsePasted(input: string) {
  const value = input.trim();
  const url = URL.parse(value);
  let params: URLSearchParams | null = null;
  if (url && (url.protocol === "http:" || url.protocol === "https:")) params = url.searchParams;
  else if (value.includes("code=")) params = new URLSearchParams(value);
  if (params) {
    return {
      code: params.get("code") || null,
      state: params.get("state") || null,
      error: params.get("error") || null,
    };
  }
  const [code, state] = value.split("#", 2);
  return { code: code || null, state: state || null, error: null };
}

export function createConnections(options: ConnectionsOptions) {
  const { connections, credentials, attempts, providers, logger } = options;
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const deviceAttempts = new Map<string, DeviceAttempt>();
  const refreshing = new Map<string, Promise<AccountCredential>>();

  function rejectIfConnected(kind: AccountKind, orgId: string) {
    if (connections.list(orgId).some((c) => c.authKind === "oauth" && c.host === kind)) {
      throw new ConnectionError(409, `${providers[kind].label} is already connected`);
    }
  }

  // Keeps what earlier tokens told about the account when new ones leave it out, and the proxy.
  function credentialOf(tokens: OAuthTokens, previous?: AccountCredential): AccountCredential {
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      expires: now().getTime() + tokens.expiresIn * 1000,
      accountId: tokens.accountId ?? previous?.accountId,
      email: tokens.email ?? previous?.email,
      plan: tokens.plan ?? previous?.plan,
      ...(previous?.proxy && { proxy: previous.proxy }),
    };
  }

  function savedCredential(connectionId: string) {
    const saved = credentials.get(connectionId);
    if (!saved) throw new ConnectionError(404, "Connection not found");
    return credentialSchema.parse(saved);
  }

  function savedAny(connectionId: string) {
    const saved = credentials.get(connectionId);
    if (!saved) throw new ConnectionError(404, "Connection not found");
    return anyCredentialSchema.parse(saved);
  }

  function save(kind: AccountKind, owner: Owner, tokens: OAuthTokens): Connection {
    rejectIfConnected(kind, owner.orgId);
    const { label } = providers[kind];
    const connection = connections.create({
      orgId: owner.orgId,
      createdBy: owner.userId,
      host: kind,
      authKind: "oauth",
      account: tokens.email ?? tokens.accountId ?? label,
    });
    credentials.put(connection.id, credentialOf(tokens));
    return connection;
  }

  function rejected(kind: AccountKind, err: unknown) {
    logger.warn({ err, kind }, "account sign-in failed");
    return new ConnectionError(
      502,
      `${providers[kind].label} did not accept the sign-in. Start again.`,
    );
  }

  async function pollUntilApproved(attempt: DeviceAttempt, oauth: DeviceOAuth, code: DeviceCode) {
    const { signal } = attempt.controller;
    let intervalMs = Math.max(MIN_POLL_MS, code.intervalSeconds * 1000);
    for (;;) {
      const result = await oauth.pollDevice(code, signal);
      if (result.status === "approved") return result;
      if (result.status === "slow_down") intervalMs += SLOW_DOWN_MS;
      const remainingMs = attempt.expiresAt.getTime() - now().getTime();
      if (remainingMs <= 0) throw new ConnectionError(400, "The code expired. Start again.");
      await sleep(Math.min(intervalMs, remainingMs), signal);
    }
  }

  async function runDevice(attempt: DeviceAttempt, oauth: DeviceOAuth, code: DeviceCode) {
    try {
      const approval = await pollUntilApproved(attempt, oauth, code);
      const tokens = await oauth.exchangeDevice(approval, attempt.controller.signal);
      if (attempt.result.status !== "pending") return;
      attempt.result = { status: "connected", connection: save(attempt.kind, attempt, tokens) };
    } catch (err) {
      if (attempt.result.status !== "pending") return;
      const error = err instanceof ConnectionError ? err : rejected(attempt.kind, err);
      attempt.result = { status: "failed", error: error.message };
    }
  }

  function cancelDevice(attempt: DeviceAttempt) {
    if (attempt.result.status === "pending") {
      attempt.result = { status: "failed", error: "Sign-in cancelled." };
    }
    attempt.controller.abort();
  }

  function findDevice(kind: AccountKind, owner: Owner, id: string) {
    const attempt = deviceAttempts.get(id);
    if (!attempt) return null;
    const ours = attempt.kind === kind && attempt.orgId === owner.orgId;
    return ours && attempt.userId === owner.userId ? attempt : null;
  }

  // Renews the connection's tokens when they are about to expire, or always when forced.
  async function renew(connectionId: string, kind: AccountKind, force: boolean) {
    const saved = credentialSchema.parse(credentials.get(connectionId));
    if (!force && saved.expires - REFRESH_SKEW_MS > now().getTime()) return saved;
    let tokens: OAuthTokens;
    try {
      tokens = await providers[kind].browser.refresh(saved.refresh);
    } catch (err) {
      logger.warn({ err, kind }, "account token refresh failed");
      throw new ConnectionError(
        502,
        `${providers[kind].label} sign-in could not be renewed. Connect again.`,
      );
    }
    // Read again, for a proxy changed while renewing; gone when disconnected meanwhile.
    const next = credentialOf(tokens, savedCredential(connectionId));
    credentials.put(connectionId, next);
    return next;
  }

  return {
    list(owner: Owner): Connection[] {
      return connections.list(owner.orgId);
    },

    // Adds a key, cloud credentials or a server to the org, under the label given, with its
    // settings and its secrets sealed. The caller has checked the host takes them.
    add(owner: Owner, input: NewHostConnection): Connection {
      const { apiKey, ...secrets } = input.secrets;
      const connection = connections.create({
        orgId: owner.orgId,
        createdBy: owner.userId,
        host: input.host,
        authKind: input.authKind,
        account: accountOf(input.settings, input.secrets),
        label: input.label,
        settings: input.settings,
      });
      credentials.put(connection.id, {
        ...(apiKey && { apiKey }),
        ...(Object.keys(secrets).length > 0 && { secrets }),
        ...(input.proxy && { proxy: input.proxy }),
      });
      return connection;
    },

    // Names a connection; null leaves it unnamed. A sign-in goes by its account.
    rename(owner: Owner, id: string, label: string | null): Connection {
      const connection = connections.find(owner.orgId, id);
      if (!connection) throw new ConnectionError(404, "Connection not found");
      if (connection.authKind === "oauth") {
        throw new ConnectionError(400, "A sign-in has no label");
      }
      connections.setLabel(id, label);
      return { ...connection, label };
    },

    // Removes a connection of the org with its credential. The provider is not told: these
    // sign-ins have no revocation.
    remove(owner: Owner, id: string) {
      if (!connections.find(owner.orgId, id))
        throw new ConnectionError(404, "Connection not found");
      credentials.delete(id);
      connections.delete(id);
    },

    // Starts a device code sign-in that the server waits on until it is approved or expires.
    async startDevice(kind: AccountKind, owner: Owner) {
      const oauth = providers[kind].device;
      if (!oauth) throw new ConnectionError(404, "This sign-in has no device code");
      rejectIfConnected(kind, owner.orgId);
      for (const attempt of deviceAttempts.values()) {
        if (attempt.expiresAt.getTime() + DEVICE_KEEP_MS <= now().getTime()) {
          cancelDevice(attempt);
          deviceAttempts.delete(attempt.id);
        } else if (findDevice(kind, owner, attempt.id)) {
          cancelDevice(attempt);
        }
      }

      const controller = new AbortController();
      let code: DeviceCode;
      try {
        code = await oauth.startDevice(controller.signal);
      } catch (err) {
        logger.warn({ err, kind }, "device code request failed");
        throw new ConnectionError(
          502,
          `Could not get a code from ${providers[kind].label}. Try again or use the browser.`,
        );
      }
      const attempt: DeviceAttempt = {
        id: randomValue(),
        kind,
        ...owner,
        expiresAt: new Date(now().getTime() + DEVICE_TTL_MS),
        controller,
        result: { status: "pending" },
      };
      deviceAttempts.set(attempt.id, attempt);
      void runDevice(attempt, oauth, code);
      return {
        attemptId: attempt.id,
        verificationUrl: code.verificationUrl,
        userCode: code.userCode,
      };
    },

    attempt(kind: AccountKind, owner: Owner, id: string): AttemptStatus {
      const attempt = findDevice(kind, owner, id);
      if (!attempt) throw new ConnectionError(404, "Sign-in not found");
      return attempt.result;
    },

    // Stops a device code sign-in, or drops a browser one.
    cancel(kind: AccountKind, owner: Owner, id: string) {
      const device = findDevice(kind, owner, id);
      if (device) cancelDevice(device);
      else if (!attempts.take({ kind, state: id, ...owner })) {
        throw new ConnectionError(404, "Sign-in not found");
      }
    },

    // Begins a browser sign-in; its state is the attempt id.
    startBrowser(kind: AccountKind, owner: Owner) {
      rejectIfConnected(kind, owner.orgId);
      attempts.deleteExpired(now());
      const { state, codeVerifier, authorizeUrl } = providers[kind].browser.authorize();
      attempts.create({
        kind,
        state,
        codeVerifier,
        ...owner,
        expiresAt: new Date(now().getTime() + BROWSER_TTL_MS),
      });
      return { attemptId: state, authorizeUrl };
    },

    // Completes a browser sign-in from the callback address, or the code, the user pasted.
    async finishBrowser(
      kind: AccountKind,
      owner: Owner,
      input: { attemptId?: string; callbackUrl: string },
    ): Promise<Connection> {
      const pasted = parsePasted(input.callbackUrl);
      if (pasted.state && input.attemptId && pasted.state !== input.attemptId) {
        throw new ConnectionError(400, "This is from a different sign-in. Start again.");
      }
      const state = pasted.state ?? input.attemptId;
      if (!state) throw new ConnectionError(400, "Paste the full address. Start again if needed.");
      const attempt = attempts.take({ kind, state, ...owner });
      if (!attempt) {
        throw new ConnectionError(400, "This sign-in is unknown or was already used. Start again.");
      }
      if (attempt.expiresAt <= now()) {
        throw new ConnectionError(400, "This sign-in has expired. Start again.");
      }
      if (pasted.error) throw new ConnectionError(400, "The sign-in was declined. Start again.");
      if (!pasted.code) throw new ConnectionError(400, "No code found in what you pasted.");

      let tokens: OAuthTokens;
      try {
        tokens = await providers[kind].browser.exchange({
          code: pasted.code,
          codeVerifier: attempt.codeVerifier,
          state,
        });
      } catch (err) {
        throw rejected(kind, err);
      }
      return save(kind, owner, tokens);
    },

    // Runs `use` with the connection's access token, renewing it first when it is about to
    // expire, or whatever its expiry when `force` is set, as after the provider refused it.
    // Renewals of one connection run one at a time, so a rotated refresh token is used once.
    async withFreshToken<T>(
      orgId: string,
      connectionId: string,
      use: (token: FreshToken) => Promise<T>,
      { force = false } = {},
    ): Promise<T> {
      const connection = connections.find(orgId, connectionId);
      if (!connection) throw new ConnectionError(404, "Connection not found");
      // Keys and cloud credentials never expire here; the host says when they no longer work, and
      // the adapters renew what cloud credentials make.
      if (connection.authKind !== "oauth") {
        const saved = secretsCredentialSchema.parse(credentials.get(connectionId));
        return use({
          access: saved.apiKey ?? "",
          accountId: null,
          proxy: saved.proxy ?? null,
          settings: connection.settings,
          secrets: saved.secrets ?? {},
        });
      }
      const kind = connection.host as AccountKind;
      let pending = refreshing.get(connectionId);
      if (!pending) {
        pending = renew(connectionId, kind, force).finally(() => refreshing.delete(connectionId));
        refreshing.set(connectionId, pending);
      }
      const credential = await pending;
      return use({
        access: credential.access,
        accountId: credential.accountId ?? null,
        proxy: credential.proxy ?? null,
      });
    },

    // The connection's proxy without its header values, or null when it has none.
    proxyOf(owner: Owner, id: string): ProxySummary | null {
      if (!connections.find(owner.orgId, id))
        throw new ConnectionError(404, "Connection not found");
      const saved = credentials.get(id);
      const proxy = saved && anyCredentialSchema.parse(saved).proxy;
      return proxy ? { baseUrl: proxy.baseUrl, headerNames: Object.keys(proxy.headers) } : null;
    },

    // Sets where the connection's provider API requests go and the headers they add. A null header
    // value keeps the stored one; a proxy with no base URL and no headers is removed.
    setProxy(owner: Owner, id: string, input: ProxyInput) {
      if (!connections.find(owner.orgId, id))
        throw new ConnectionError(404, "Connection not found");
      const saved = savedAny(id);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers)) {
        const kept = value ?? saved.proxy?.headers[name];
        if (kept === undefined) throw new ConnectionError(400, `Give a value for ${name}`);
        headers[name] = kept;
      }
      const { proxy: _proxy, ...rest } = saved;
      const empty = !input.baseUrl && Object.keys(headers).length === 0;
      credentials.put(id, empty ? rest : { ...rest, proxy: { baseUrl: input.baseUrl, headers } });
    },
  };
}
