// The query cache kept in IndexedDB between visits, under the signed-in user's id, so a reload or
// a thread switch paints from it while the server is asked for what changed. It keeps spaces,
// folders, thread lists and threads with their events; not who is signed in, their connections,
// the models or the settings. A new build or seven days discard it.

import { defaultShouldDehydrateQuery, type Query, type QueryClient } from "@tanstack/react-query";
import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";

import { sessionQuery } from "@/web/lib/queries";

export const cacheMaxAge = 7 * 24 * 60 * 60 * 1000;

// The first part of the keys of the queries that are kept.
const KEPT = new Set(["spaces", "threads"]);

export function shouldPersist(query: Query): boolean {
  const root = query.queryKey[0];
  return typeof root === "string" && KEPT.has(root) && defaultShouldDehydrateQuery(query);
}

function cacheKey(userId: string) {
  return `query-cache:${userId}`;
}

function signedInUser(queryClient: QueryClient) {
  return queryClient.getQueryData(sessionQuery.queryKey)?.user.id;
}

// Restoring waits for the session, as every signed-in page does before it shows anything; writes
// go under the user signed in at the time.
function createPersister(queryClient: QueryClient): Persister {
  return {
    async persistClient(client: PersistedClient) {
      const userId = signedInUser(queryClient);
      if (userId) await set(cacheKey(userId), client);
    },
    async restoreClient() {
      const session = await queryClient.fetchQuery(sessionQuery).catch(() => null);
      return session ? get<PersistedClient>(cacheKey(session.user.id)) : undefined;
    },
    async removeClient() {
      const userId = signedInUser(queryClient);
      if (userId) await del(cacheKey(userId));
    },
  };
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

// Forgets everything cached for the signed-in user, in memory and in IndexedDB.
export async function forgetCache(queryClient: QueryClient) {
  const userId = signedInUser(queryClient);
  queryClient.clear();
  if (userId) await del(cacheKey(userId));
}
