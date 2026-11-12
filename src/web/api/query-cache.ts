// The query cache kept in IndexedDB between visits, under the signed-in user's id and the tab's org,
// so a reload or a thread switch paints from it while the server is asked for what changed, and so
// the threads read before can be read again offline. It keeps who is signed in, spaces,
// thread lists and threads with their newest page of rows; not the session, their connections, the
// models or the settings. Beside it is who signed in last, and in which org: while the server cannot be
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

import type { ShownRow } from "@/shared/threads/rows.ts";
import { adoptOrg, forgetOrg, tabOrg } from "@/web/lib/org-tab";
import { sessionQuery } from "@/web/auth/queries";
import { withLatestPage } from "@/web/threads/thread-rows";

export const cacheMaxAge = 7 * 24 * 60 * 60 * 1000;

// The first part of the keys of the queries that are kept.
const KEPT = new Set(["me", "spaces", "shared-threads", "threads"]);

export function shouldPersist(query: Query): boolean {
  const root = query.queryKey[0];
  return typeof root === "string" && KEPT.has(root) && defaultShouldDehydrateQuery(query);
}

// The client with each cached thread cut to its newest page of rows, so a thread read once opens
// from the cache as it does from the server, and what was scrolled back to is not kept.
export function withLatestPages(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.map((query) => {
    const data = query.state.data as { rows?: ShownRow[]; before?: number | null } | undefined;
    if (query.queryKey[0] !== "threads" || !Array.isArray(data?.rows)) return query;
    const kept = withLatestPage(data as { rows: ShownRow[]; before: number | null });
    return kept === data ? query : { ...query, state: { ...query.state, data: kept } };
  });
  return { ...client, clientState: { ...client.clientState, queries } };
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

// Who signed in last in this browser, read from storage without asking the server, so pages show
// at once from what was kept for them. A tab that names no org takes the one they were in only
// while the server cannot be reached; otherwise it learns its org from the server, which knows
// whether they are still in the one they were in. The server is asked about the session in the
// background, and `sessionReported` acts on what it says.
export async function lastOwner(): Promise<CacheOwner | undefined> {
  const last = await get<CacheOwner>(LAST_KEY);
  if (!last) return undefined;
  if (tabOrg()) return last;
  if (onlineManager.isOnline()) return undefined;
  adoptOrg(last.orgId);
  return last;
}

// The user whose cache was restored, until the server confirms or contradicts it.
let restoredFor: string | undefined;

// Whether the server has said someone is signed in since nobody was.
let signedInHere = false;

// What the server says of the session once it is read: nobody is signed in, so everything kept is
// forgotten and the guards run again, which leads to sign-in; or another user is, so what was
// restored for the last one is dropped and read again.
export async function sessionReported(
  queryClient: QueryClient,
  session: { user: { id: string } } | null,
  guardsAgain: () => void,
) {
  // What was kept is restored before it is judged.
  await restored;
  if (!session) {
    // Nothing was known of anyone, as on the sign-in page: nobody to sign out.
    if (!signedInHere && !(await get<CacheOwner>(LAST_KEY))) return;
    await forgetCache(queryClient);
    guardsAgain();
    return;
  }
  signedInHere = true;
  if (restoredFor && restoredFor !== session.user.id) {
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    forgetOrg();
    guardsAgain();
  }
  restoredFor = undefined;
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

// Restoring does not wait for the server: it reads what was kept for whoever signed in last, in
// the tab's org. Writes go under the user signed in and the tab's org at the time, who become the
// last to have signed in; before the session is read after a reload, nothing is written.
function createPersister(queryClient: QueryClient): Persister {
  return {
    async persistClient(client: PersistedClient) {
      const userId = signedInUser(queryClient);
      const orgId = tabOrg();
      if (!userId || !orgId) return;
      await set(cacheKey(userId, orgId), withLatestPages(client));
      await set(LAST_KEY, { userId, orgId } satisfies CacheOwner);
    },
    async restoreClient() {
      const last = await lastOwner();
      if (!last) return undefined;
      restoredFor = last.userId;
      return get<PersistedClient>(cacheKey(last.userId, tabOrg() ?? last.orgId));
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
  const userId = signedInUser(queryClient) ?? (await get<CacheOwner>(LAST_KEY))?.userId;
  signedInHere = false;
  restoredFor = undefined;
  // The next to sign in here learns their own org.
  forgetOrg();
  queryClient.clear();
  await del(LAST_KEY);
  if (!userId) return;
  const prefix = `query-cache:${userId}`;
  for (const key of await keys()) {
    if (typeof key === "string" && (key === prefix || key.startsWith(`${prefix}:`))) await del(key);
  }
}
