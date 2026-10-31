// The query cache kept in IndexedDB between visits, under the signed-in user's id and the tab's org,
// so a reload or a thread switch paints from it while the server is asked for what changed, and so
// the threads read before can be read again offline. It keeps who is signed in, spaces, folders,
// thread lists and threads with their events; not the session, their connections, the models or
// the settings. Beside it is who signed in last, and in which org: while the server cannot be
// reached, the app opens as them, from their cache. A new build or seven days discard it; signing
// out forgets it all.

import {
  defaultShouldDehydrateQuery,
  onlineManager,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import { del, get, keys, set } from "idb-keyval";

import { adoptOrg, tabOrg } from "@/web/lib/org-tab";
import { meQuery, sessionQuery } from "@/web/auth/queries";

export const cacheMaxAge = 7 * 24 * 60 * 60 * 1000;

// The first part of the keys of the queries that are kept.
const KEPT = new Set(["me", "spaces", "shared-threads", "threads"]);

export function shouldPersist(query: Query): boolean {
  const root = query.queryKey[0];
  return typeof root === "string" && KEPT.has(root) && defaultShouldDehydrateQuery(query);
}

function cacheKey(userId: string, orgId: string) {
  return `query-cache:${userId}:${orgId}`;
}

// Who signed in last in this browser, and the org they were in.
export interface CacheOwner {
  userId: string;
  orgId: string;
}

const LAST_KEY = "query-cache:last";

// The server could not be reached, as when the browser is offline: the request never got an answer.
export function unreachable(error: unknown) {
  return error instanceof TypeError || !onlineManager.isOnline();
}

// Whose cache to restore: the signed-in user's, in the tab's org; while the server cannot be
// reached, the user who signed in last's, in the tab's org or the one they were in; nobody's when
// signed out, or when the session cannot be read for another reason.
export async function cacheOwner(read: {
  session(): Promise<{ user: { id: string } } | null>;
  // The tab's org, learned from the server when the tab does not know it yet.
  org(): Promise<string | null>;
  tabOrg(): string | null;
  last(): Promise<CacheOwner | undefined>;
}): Promise<CacheOwner | null> {
  let session: { user: { id: string } } | null;
  try {
    session = await read.session();
  } catch (error) {
    if (!unreachable(error)) return null;
    const last = await read.last();
    return last ? { userId: last.userId, orgId: read.tabOrg() ?? last.orgId } : null;
  }
  if (!session) return null;
  const orgId = await read.org();
  return orgId ? { userId: session.user.id, orgId } : null;
}

// While the server cannot be reached for the session, the user who signed in last, with the tab in
// their org, so the app opens from what was kept for them; otherwise the error stands.
export async function lastSignedIn(error: unknown): Promise<CacheOwner> {
  const last = unreachable(error) ? await get<CacheOwner>(LAST_KEY) : undefined;
  if (!last) throw error;
  adoptOrg(last.orgId);
  return last;
}

function signedInUser(queryClient: QueryClient) {
  return queryClient.getQueryData(sessionQuery.queryKey)?.user.id;
}

// Restoring waits for the session, as every signed-in page does before it shows anything, and for
// the tab's org; writes go under the user signed in and the tab's org at the time, who become the
// last to have signed in.
function createPersister(queryClient: QueryClient): Persister {
  return {
    async persistClient(client: PersistedClient) {
      const userId = signedInUser(queryClient);
      const orgId = tabOrg();
      if (!userId || !orgId) return;
      await set(cacheKey(userId, orgId), client);
      await set(LAST_KEY, { userId, orgId } satisfies CacheOwner);
    },
    async restoreClient() {
      const owner = await cacheOwner({
        session: () => queryClient.fetchQuery(sessionQuery),
        async org() {
          // A tab that does not know its org yet learns it from who is signed in.
          if (!tabOrg()) await queryClient.fetchQuery(meQuery).catch(() => null);
          return tabOrg();
        },
        tabOrg,
        last: () => get<CacheOwner>(LAST_KEY),
      });
      if (!owner) return undefined;
      adoptOrg(owner.orgId);
      return get<PersistedClient>(cacheKey(owner.userId, owner.orgId));
    },
    async removeClient() {
      const userId = signedInUser(queryClient);
      const orgId = tabOrg();
      if (userId && orgId) await del(cacheKey(userId, orgId));
    },
  };
}

let settle = () => {};

// Settles once the kept cache is restored, or found to have nothing to restore.
export const restored = new Promise<void>((resolve) => {
  settle = resolve;
});

export function cacheRestored() {
  settle();
}

export function cacheOptions(
  queryClient: QueryClient,
): Omit<PersistQueryClientOptions, "queryClient"> {
  return {
    persister: createPersister(queryClient),
    maxAge: cacheMaxAge,
    buster: __BUILD_ID__,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
  };
}

// Forgets everything cached for the signed-in user, in every org, in memory and in IndexedDB, and
// that anyone signed in here.
export async function forgetCache(queryClient: QueryClient) {
  const userId = signedInUser(queryClient);
  queryClient.clear();
  await del(LAST_KEY);
  if (!userId) return;
  const prefix = `query-cache:${userId}`;
  for (const key of await keys()) {
    if (typeof key === "string" && (key === prefix || key.startsWith(`${prefix}:`))) await del(key);
  }
}
