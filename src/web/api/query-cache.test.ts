import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";

import type { PersistedClient } from "@tanstack/react-query-persist-client";

import { ROWS_PAGE } from "@/shared/threads/rows.ts";
import { shouldPersist, withLatestPages } from "@/web/api/query-cache.ts";

// A query in the cache that has answered once.
function settled(queryClient: QueryClient, queryKey: readonly unknown[]) {
  queryClient.setQueryData(queryKey, { any: "data" });
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) throw new Error("query not built");
  return query;
}

describe("shouldPersist", () => {
  const queryClient = new QueryClient();

  it.each([["me"], ["spaces"], ["spaces", "s1", "threads"], ["threads", "t1"]])(
    "keeps %j",
    (...queryKey) => {
      expect(shouldPersist(settled(queryClient, queryKey))).toBe(true);
    },
  );

  it.each([["session"], ["connections"], ["models"], ["default-model"], ["codex-attempt", "a1"]])(
    "leaves %j out",
    (...queryKey) => {
      expect(shouldPersist(settled(queryClient, queryKey))).toBe(false);
    },
  );

  it("leaves out a kept query that has not answered yet", () => {
    const queryKey: readonly unknown[] = ["threads", "t2"];
    const query = queryClient.getQueryCache().build(queryClient, { queryKey });
    expect(shouldPersist(query)).toBe(false);
  });
});

describe("withLatestPages", () => {
  const client = (data: unknown, queryKey: readonly unknown[]) =>
    ({
      clientState: { mutations: [], queries: [{ queryKey, state: { data } }] },
    }) as unknown as PersistedClient;
  const rows = (count: number) => Array.from({ length: count }, (_, order) => ({ order }));
  const dataOf = (kept: PersistedClient) =>
    kept.clientState.queries[0]!.state.data as never as {
      rows: { order: number }[];
      before: number | null;
    };

  it("cuts a thread to its newest page, and says where it starts", () => {
    const kept = dataOf(
      withLatestPages(client({ rows: rows(200), before: 20 }, ["threads", "t1"])),
    );

    expect(kept.rows).toHaveLength(ROWS_PAGE);
    expect(kept.rows[0]!.order).toBe(200 - ROWS_PAGE);
    expect(kept.before).toBe(200 - ROWS_PAGE);
  });

  it("leaves a thread within a page, and other queries, as they are", () => {
    const short = client({ rows: rows(5), before: null }, ["threads", "t1"]);
    const other = client({ rows: rows(200), before: 3 }, ["spaces", "s1"]);

    expect(withLatestPages(short)).toEqual(short);
    expect(withLatestPages(other)).toEqual(other);
  });
});
