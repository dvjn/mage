import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";

import { shouldPersist } from "@/web/lib/query-cache.ts";

// A query in the cache that has answered once.
function settled(queryClient: QueryClient, queryKey: readonly unknown[]) {
  queryClient.setQueryData(queryKey, { any: "data" });
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) throw new Error("query not built");
  return query;
}

describe("shouldPersist", () => {
  const queryClient = new QueryClient();

  it.each([
    ["spaces"],
    ["spaces", "s1", "folders"],
    ["spaces", "s1", "threads"],
    ["threads", "t1"],
  ])("keeps %j", (...queryKey) => {
    expect(shouldPersist(settled(queryClient, queryKey))).toBe(true);
  });

  it.each([
    ["session"],
    ["me"],
    ["connections"],
    ["models"],
    ["default-model"],
    ["codex-attempt", "a1"],
  ])("leaves %j out", (...queryKey) => {
    expect(shouldPersist(settled(queryClient, queryKey))).toBe(false);
  });

  it("leaves out a kept query that has not answered yet", () => {
    const queryKey: readonly unknown[] = ["threads", "t2"];
    const query = queryClient.getQueryCache().build(queryClient, { queryKey });
    expect(shouldPersist(query)).toBe(false);
  });
});
