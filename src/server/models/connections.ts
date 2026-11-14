// An org's connections: made by signing in to a provider account the way the provider's own
// coding app does, with a device code or a code the provider shows to paste back, kept usable by
// renewing their tokens, or by adding a key, cloud credentials or a server's address for a host,
// and optionally sending their requests through a proxy, kept sealed with the tokens or the
// secrets. Those not signed in to can be changed later, a secret left blank keeping the stored one.

import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import * as z from "zod";

import type { Logger } from "@/server/kernel/logger.ts";
import type { OAuthAttempts } from "@/server/oauth/attempts.ts";
import type { Sync, Transact } from "@/server/sync/sync.ts";
import type { Lease } from "@/server/sync/lease.ts";
import type { ProxyInput, ProxySummary } from "@/shared/connections.ts";
import type { AuthKind, HostId } from "@/shared/hosts.ts";

import type { ProviderProxy } from "./gateway.ts";
import type { CodeOAuth, DeviceCode, DeviceOAuth, OAuthTokens } from "./oauth.ts";

export interface Connection {
  id: string;
  orgId: string;
  // The user who connected it; null once that user is gone.
  createdBy: string | null;
  // Who serves its models.
  host: HostId;
  // A subscription sign-in, a key, cloud credentials or a server's address; an org has one sign-in
  // of each host, and any number of the rest.
  authKind: AuthKind;
  // The account signed in to, a key's masked hint, or what else tells the credentials apart.
  account: string;
  // The name people gave it; null for sign-ins.
  label: string | null;
  // What is not secret about how it connects: the way it does, and fields such as its region.
  settings: Record<string, string>;
  // Whether models the provider adds are turned on when first seen.
  autoEnableModels: boolean;
  createdAt: Date;
}

export type NewConnection = Omit<
  Connection,
  "id" | "createdAt" | "createdBy" | "label" | "autoEnableModels" | "settings"
> & {
  createdBy: string;
  label?: string | null;
  settings?: Record<string, string>;
};

export type ConnectionChanges = Partial<
  Pick<Connection, "authKind" | "account" | "label" | "settings">
>;

export interface ConnectionStore {
  create(connection: NewConnection): Promise<Connection>;
  list(orgId: string): Promise<Connection[]>;
  // The connection with this id when it belongs to the org.
  find(orgId: string, id: string): Promise<Connection | null>;
  update(id: string, changes: ConnectionChanges): Promise<void>;
  setAutoEnableModels(id: string, on: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

export type Credential = Record<string, unknown>;

export interface CredentialStore {
  put(connectionId: string, credential: Credential): Promise<void>;
  // Null when the connection has none; throws when the stored value fails authentication.
  get(connectionId: string): Promise<Credential | null>;
  delete(connectionId: string): Promise<void>;
  // Holds the credential for one renewal, if nobody else does; null when someone does or there is
  // none.
  lease(connectionId: string, owner: string, ms: number): Promise<Lease | null>;
  // Stores the renewed credential and lets it go; false when the lease no longer held.
  putHeld(connectionId: string, lease: Lease, credential: Credential): Promise<boolean>;
  release(connectionId: string, lease: Lease): Promise<void>;
  // Stores the credential when what is stored passes `holds`, in one locked read and write.
  putIf(
    connectionId: string,
    holds: (stored: Credential) => boolean,
    credential: Credential,
  ): Promise<boolean>;
}

// The hosts signed in to with a subscription: by a device code, or by pasting back a code.
export type DeviceKind = "codex";
export type CodeKind = "claude";
export type AccountKind = DeviceKind | CodeKind;

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

export interface AccountProvider<OAuth extends DeviceOAuth | CodeOAuth> {
  // How people know the sign-in, as in "Sign in with Codex".
  label: string;
  oauth: OAuth;
}

export type AccountProviders = Record<DeviceKind, AccountProvider<DeviceOAuth>> &
  Record<CodeKind, AccountProvider<CodeOAuth>>;

export interface ConnectionsOptions {
  connections: ConnectionStore;
  credentials: CredentialStore;
  providers: AccountProviders;
  logger: Logger;
  now?: () => Date;
  // Where sign-ins under way are kept, so any instance finishes them.
  attempts: OAuthAttempts;
  // Names this instance in the leases it takes on device sign-ins it asks about.
  instanceId: string;
  // Runs the pass that asks providers about device sign-ins, on every instance.
  ticker?: Sync["ticker"];
  // Makes a connection and finishes the sign-in that made it in one write.
  transact: Transact;
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

// A connection's new label, way of connecting and fields, its host and proxy staying.
export type HostConnectionChange = Omit<NewHostConnection, "host" | "proxy">;

export interface FreshToken {
  access: string;
  accountId: string | null;
  proxy: ProviderProxy | null;
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
}

const DEVICE_TTL_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
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

// A sign-in waiting for the code its authorization shows; its state is its id.
// What a device sign-in keeps sealed while it waits: the provider's code and how long to wait
// between asks.
interface DeviceSecrets {
  code: DeviceCode;
  intervalMs: number;
}

// How long one ask about a device sign-in holds it, and how often instances look for asks due.
const DEVICE_LEASE_MS = 30_000;
const DEVICE_PASS_MS = 1000;
// How long an instance may take to renew a connection's tokens before another may, and how often one
// waiting on it looks again.
const RENEW_LEASE_MS = 30_000;
const RENEW_WAIT_MS = 100;

function randomValue() {
  return randomBytes(32).toString("base64url");
}

// The code and state in what the person pasted: `code#state`, the address the browser ended on,
// its query, or the bare code.
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

// The end of a secret as people may see it again: a key's hint, a service account's address, or
// the last four characters of a long value.
export function secretHint(name: string, value: string) {
  if (name === "apiKey") return keyHint(value);
  if (name === "serviceAccount") {
    try {
      return (JSON.parse(value) as { client_email?: string }).client_email ?? "Service account";
    } catch {
      return "Service account";
    }
  }
  return value.length >= 12 ? `…${value.slice(-4)}` : "••••";
}

export function createConnections(options: ConnectionsOptions) {
  const { connections, credentials, providers, logger, attempts } = options;
  const now = options.now ?? (() => new Date());
  const refreshing = new Map<string, Promise<AccountCredential>>();

  async function rejectIfConnected(kind: AccountKind, orgId: string) {
    if ((await connections.list(orgId)).some((c) => c.authKind === "oauth" && c.host === kind)) {
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

  async function savedCredential(connectionId: string) {
    const saved = await credentials.get(connectionId);
    if (!saved) throw new ConnectionError(404, "Connection not found");
    return credentialSchema.parse(saved);
  }

  async function savedAny(connectionId: string) {
    const saved = await credentials.get(connectionId);
    if (!saved) throw new ConnectionError(404, "Connection not found");
    return anyCredentialSchema.parse(saved);
  }

  async function save(kind: AccountKind, owner: Owner, tokens: OAuthTokens): Promise<Connection> {
    await rejectIfConnected(kind, owner.orgId);
    const { label } = providers[kind];
    const connection = await connections.create({
      orgId: owner.orgId,
      createdBy: owner.userId,
      host: kind,
      authKind: "oauth",
      account: tokens.email ?? tokens.accountId ?? label,
    });
    await credentials.put(connection.id, credentialOf(tokens));
    return connection;
  }

  function rejected(kind: AccountKind, err: unknown) {
    logger.warn({ err, kind }, "account sign-in failed");
    return new ConnectionError(
      502,
      `${providers[kind].label} did not accept the sign-in. Start again.`,
    );
  }

  // The person's sign-in of the kind and flow, or null when it is not theirs.
  async function mine<Secrets>(
    kind: AccountKind,
    flow: "device" | "code",
    owner: Owner,
    id: string,
  ) {
    const attempt = await attempts.find<Secrets>(id);
    const ours =
      attempt?.kind === "model" &&
      attempt.flow === flow &&
      attempt.subjectId === kind &&
      attempt.orgId === owner.orgId &&
      attempt.userId === owner.userId;
    return ours ? attempt : null;
  }

  // Drops the person's earlier sign-ins of the kind and flow still under way.
  async function dropEarlier(kind: AccountKind, flow: "device" | "code", owner: Owner) {
    for (const earlier of await attempts.pendingOf("model", kind, owner.orgId, owner.userId)) {
      if (earlier.flow === flow) await attempts.fail(earlier.state, "Sign-in cancelled.");
    }
  }

  // Asks the provider once about each device sign-in whose ask has come, held for that ask: the
  // ask itself outside any transaction, what follows under the hold. Approved, the connection is
  // made and the sign-in finished in one write; still waiting, it is asked again after its
  // interval, longer when the provider says to slow down; past its time, it runs out.
  async function askDevices() {
    for (const state of await attempts.due(now(), 20)) {
      const held = await attempts.hold(state, now(), options.instanceId, DEVICE_LEASE_MS);
      if (!held) continue;
      const { attempt, lease } = held;
      const kind = attempt.subjectId as DeviceKind;
      const secrets = attempt.secrets as DeviceSecrets;
      const { oauth } = providers[kind];
      try {
        const result = await oauth.pollDevice(secrets.code);
        if (result.status === "approved") {
          const tokens = await oauth.exchangeDevice(result);
          const owner = { orgId: attempt.orgId, userId: attempt.userId };
          await options.transact(async () => {
            const connection = await save(kind, owner, tokens);
            if (!(await attempts.completeHeld(lease, connection.id))) {
              throw new ConnectionError(409, "Sign-in cancelled.");
            }
          });
          continue;
        }
        const intervalMs =
          result.status === "slow_down" ? secrets.intervalMs + SLOW_DOWN_MS : secrets.intervalMs;
        const remainingMs = attempt.expiresAt.getTime() - now().getTime();
        if (remainingMs <= 0) {
          await attempts.failHeld(lease, "The code expired. Start again.", true);
          continue;
        }
        await attempts.polled(
          lease,
          new Date(now().getTime() + Math.min(intervalMs, remainingMs)),
          {
            ...secrets,
            intervalMs,
          },
        );
      } catch (err) {
        const error = err instanceof ConnectionError ? err : rejected(kind, err);
        await attempts.failHeld(lease, error.message);
      }
    }
  }
  const devicePass = options.ticker?.("device-sign-ins", askDevices, DEVICE_PASS_MS);

  // Renews the connection's tokens when they are about to expire, or always when forced. One
  // instance renews at a time, under the credential's lease: the holder reads the credential again
  // and uses it when someone renewed meanwhile, else asks the provider outside any transaction and
  // stores what it gets under the lease. An instance without the lease waits for it to be let go
  // or run out, and uses what was stored.
  async function renew(connectionId: string, kind: AccountKind, force: boolean, refused?: string) {
    const seen = credentialSchema.parse(await credentials.get(connectionId));
    const fresh = (c: AccountCredential) => c.expires - REFRESH_SKEW_MS > now().getTime();
    if (!force && fresh(seen)) return seen;
    // Renewed since the provider refused the token it was given.
    if (refused !== undefined && seen.access !== refused) return seen;
    for (;;) {
      const lease = await credentials.lease(connectionId, options.instanceId, RENEW_LEASE_MS);
      const saved = await savedCredential(connectionId);
      if (saved.access !== seen.access || saved.refresh !== seen.refresh) {
        if (lease) await credentials.release(connectionId, lease);
        return saved;
      }
      if (!lease) {
        await sleep(RENEW_WAIT_MS);
        continue;
      }
      let tokens: OAuthTokens;
      try {
        tokens = await providers[kind].oauth.refresh(saved.refresh);
      } catch (err) {
        await credentials.release(connectionId, lease);
        logger.warn({ err, kind }, "account token refresh failed");
        throw new ConnectionError(
          502,
          `${providers[kind].label} sign-in could not be renewed. Connect again.`,
        );
      }
      // Read again, for a proxy changed while renewing; gone when disconnected meanwhile.
      const next = credentialOf(tokens, await savedCredential(connectionId));
      // The lease ran out meanwhile: the refresh token is spent all the same, so what it got is
      // kept unless someone stored a renewal of their own since.
      if (
        !(await credentials.putHeld(connectionId, lease, next)) &&
        !(await credentials.putIf(connectionId, (stored) => stored.refresh === saved.refresh, next))
      ) {
        return savedCredential(connectionId);
      }
      return next;
    }
  }

  return {
    async list(owner: Owner): Promise<Connection[]> {
      return connections.list(owner.orgId);
    },

    // Adds a key, cloud credentials or a server to the org, under the label given, with its
    // settings and its secrets sealed. The caller has checked the host takes them.
    async add(owner: Owner, input: NewHostConnection): Promise<Connection> {
      const { apiKey, ...secrets } = input.secrets;
      const connection = await connections.create({
        orgId: owner.orgId,
        createdBy: owner.userId,
        host: input.host,
        authKind: input.authKind,
        account: accountOf(input.settings, input.secrets),
        label: input.label,
        settings: input.settings,
      });
      await credentials.put(connection.id, {
        ...(apiKey && { apiKey }),
        ...(Object.keys(secrets).length > 0 && { secrets }),
        ...(input.proxy && { proxy: input.proxy }),
      });
      return connection;
    },

    // The values a change of the connection is checked with: its settings and secrets by field
    // name, with the values given over them; a secret left blank keeps the stored one.
    async editValues(owner: Owner, id: string, values: Record<string, string>) {
      const connection = await connections.find(owner.orgId, id);
      if (!connection) throw new ConnectionError(404, "Connection not found");
      if (connection.authKind === "oauth") {
        throw new ConnectionError(400, "A sign-in has nothing to change");
      }
      const saved = secretsCredentialSchema.parse((await credentials.get(id)) ?? {});
      const stored: Record<string, string> = {
        ...saved.secrets,
        ...(saved.apiKey && { apiKey: saved.apiKey }),
      };
      const merged: Record<string, string> = { ...connection.settings, ...stored };
      for (const [name, value] of Object.entries(values)) {
        if (!value.trim() && name in stored) continue;
        merged[name] = value;
      }
      return { connection, values: merged };
    },

    // Saves a connection's new label, way of connecting and fields, with its secrets sealed and
    // its proxy kept. The caller has checked the host takes them.
    async edit(owner: Owner, id: string, change: HostConnectionChange): Promise<Connection> {
      const connection = await connections.find(owner.orgId, id);
      if (!connection) throw new ConnectionError(404, "Connection not found");
      const saved = await savedAny(id);
      const { apiKey, ...secrets } = change.secrets;
      const changes = {
        authKind: change.authKind,
        account: accountOf(change.settings, change.secrets),
        label: change.label,
        settings: change.settings,
      };
      await connections.update(id, changes);
      await credentials.put(id, {
        ...(apiKey && { apiKey }),
        ...(Object.keys(secrets).length > 0 && { secrets }),
        ...(saved.proxy && { proxy: saved.proxy }),
      });
      return { ...connection, ...changes };
    },

    // The ends of the connection's secrets by field name, as people may see them again.
    async hintsOf(owner: Owner, id: string): Promise<Record<string, string>> {
      const connection = await connections.find(owner.orgId, id);
      if (!connection || connection.authKind === "oauth") return {};
      const saved = secretsCredentialSchema.safeParse((await credentials.get(id)) ?? {});
      if (!saved.success) return {};
      const { apiKey, secrets = {} } = saved.data;
      return Object.fromEntries(
        Object.entries({ ...secrets, ...(apiKey && { apiKey }) }).map(([name, value]) => [
          name,
          secretHint(name, value),
        ]),
      );
    },

    // Removes a connection of the org with its credential. The provider is not told: these
    // sign-ins have no revocation.
    async remove(owner: Owner, id: string) {
      if (!(await connections.find(owner.orgId, id)))
        throw new ConnectionError(404, "Connection not found");
      await credentials.delete(id);
      await connections.delete(id);
    },

    // Starts a device code sign-in, which instances ask the provider about until it is approved
    // or expires, whether or not anyone reads where it stands. The user's earlier one is dropped.
    async startDevice(kind: DeviceKind, owner: Owner) {
      const { oauth } = providers[kind];
      await rejectIfConnected(kind, owner.orgId);
      await dropEarlier(kind, "device", owner);
      let code: DeviceCode;
      try {
        code = await oauth.startDevice();
      } catch (err) {
        logger.warn({ err, kind }, "device code request failed");
        throw new ConnectionError(
          502,
          `Could not get a code from ${providers[kind].label}. Try again.`,
        );
      }
      const state = randomValue();
      const secrets: DeviceSecrets = {
        code,
        intervalMs: Math.max(MIN_POLL_MS, code.intervalSeconds * 1000),
      };
      await attempts.begin({
        state,
        kind: "model",
        flow: "device",
        subjectId: kind,
        holder: owner.userId,
        ...owner,
        secrets,
        expiresAt: new Date(now().getTime() + DEVICE_TTL_MS),
        nextPollAt: now(),
        now: now(),
      });
      void devicePass?.now();
      return { attemptId: state, verificationUrl: code.verificationUrl, userCode: code.userCode };
    },

    // Where the person's device sign-in stands, as its row says.
    async attempt(kind: DeviceKind, owner: Owner, id: string): Promise<AttemptStatus> {
      const attempt = await mine(kind, "device", owner, id);
      if (!attempt) throw new ConnectionError(404, "Sign-in not found");
      if (attempt.status === "pending") return { status: "pending" };
      if (attempt.status === "completed") {
        const connection = attempt.resultId
          ? await connections.find(owner.orgId, attempt.resultId)
          : null;
        if (connection) return { status: "connected", connection };
      }
      return { status: "failed", error: attempt.error ?? "Sign-in cancelled." };
    },

    // Stops a device code sign-in.
    async cancel(kind: DeviceKind, owner: Owner, id: string) {
      const attempt = await mine(kind, "device", owner, id);
      if (!attempt) throw new ConnectionError(404, "Sign-in not found");
      await attempts.fail(id, "Sign-in cancelled.");
    },

    // Asks the providers about device sign-ins whose ask has come, as the pass does.
    askDevices,
    start: async () => devicePass?.start(),
    stop: async () => devicePass?.stop(),

    // Starts a sign-in whose authorization ends on a page showing a code to paste back. The
    // user's earlier one is dropped.
    async startAuthorization(kind: CodeKind, owner: Owner) {
      await rejectIfConnected(kind, owner.orgId);
      await dropEarlier(kind, "code", owner);
      const { state, codeVerifier, authorizeUrl } = providers[kind].oauth.authorize();
      await attempts.begin({
        state,
        kind: "model",
        flow: "code",
        subjectId: kind,
        holder: owner.userId,
        ...owner,
        secrets: { codeVerifier },
        expiresAt: new Date(now().getTime() + CODE_TTL_MS),
        now: now(),
      });
      return { attemptId: state, authorizeUrl };
    },

    // Finishes the sign-in with what the person pasted; each authorization is tried once.
    async finishAuthorization(
      kind: CodeKind,
      owner: Owner,
      id: string,
      pastedInput: string,
    ): Promise<Connection> {
      const pasted = parsePasted(pastedInput);
      if (pasted.state && pasted.state !== id) {
        throw new ConnectionError(400, "This is from a different sign-in. Start again.");
      }
      const attempt = await mine<{ codeVerifier: string }>(kind, "code", owner, id);
      if (!attempt || attempt.status !== "pending") {
        throw new ConnectionError(404, "Sign-in not found. Start again.");
      }
      if (!pasted.error && !pasted.code) throw new ConnectionError(400, "Paste the code");
      if (attempt.expiresAt <= now()) {
        await attempts.fail(id, "The sign-in expired.");
        throw new ConnectionError(400, "The sign-in expired. Start again.");
      }
      if (pasted.error) {
        await attempts.fail(id, "The sign-in was declined.");
        throw new ConnectionError(400, "The sign-in was declined. Start again.");
      }
      // Tried once: a second try finds it finished, before the provider is asked.
      if (!(await attempts.complete(id))) {
        throw new ConnectionError(404, "Sign-in not found. Start again.");
      }
      let tokens: OAuthTokens;
      try {
        tokens = await providers[kind].oauth.exchange({
          code: pasted.code ?? "",
          codeVerifier: attempt.secrets.codeVerifier,
          state: id,
        });
      } catch (err) {
        throw rejected(kind, err);
      }
      return save(kind, owner, tokens);
    },

    // Runs `use` with the connection's access token, renewing it first when it is about to
    // expire, or whatever its expiry when `force` is set, as after the provider refused it;
    // `refused`, the token it refused, is not renewed again once another is stored.
    // Callers in this process share one renewal of a connection; instances take turns by lease.
    async withFreshToken<T>(
      orgId: string,
      connectionId: string,
      use: (token: FreshToken) => Promise<T>,
      { force = false, refused }: { force?: boolean; refused?: string } = {},
    ): Promise<T> {
      const connection = await connections.find(orgId, connectionId);
      if (!connection) throw new ConnectionError(404, "Connection not found");
      // Keys and cloud credentials never expire here; the host says when they no longer work, and
      // the adapters renew what cloud credentials make.
      if (connection.authKind !== "oauth") {
        const saved = secretsCredentialSchema.parse(await credentials.get(connectionId));
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
        pending = renew(connectionId, kind, force, refused).finally(() =>
          refreshing.delete(connectionId),
        );
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
    async proxyOf(owner: Owner, id: string): Promise<ProxySummary | null> {
      if (!(await connections.find(owner.orgId, id)))
        throw new ConnectionError(404, "Connection not found");
      const saved = await credentials.get(id);
      const proxy = saved && anyCredentialSchema.parse(saved).proxy;
      return proxy ? { baseUrl: proxy.baseUrl, headerNames: Object.keys(proxy.headers) } : null;
    },

    // Sets where the connection's provider API requests go and the headers they add. A null header
    // value keeps the stored one; a proxy with no base URL and no headers is removed.
    async setProxy(owner: Owner, id: string, input: ProxyInput) {
      if (!(await connections.find(owner.orgId, id)))
        throw new ConnectionError(404, "Connection not found");
      const saved = await savedAny(id);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers)) {
        const kept = value ?? saved.proxy?.headers[name];
        if (kept === undefined) throw new ConnectionError(400, `Give a value for ${name}`);
        headers[name] = kept;
      }
      const { proxy: _proxy, ...rest } = saved;
      const empty = !input.baseUrl && Object.keys(headers).length === 0;
      await credentials.put(
        id,
        empty ? rest : { ...rest, proxy: { baseUrl: input.baseUrl, headers } },
      );
    },
  };
}
