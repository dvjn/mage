import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";

import { type CacheOwner, cacheOwner, shouldPersist } from "@/web/api/query-cache.ts";

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
    ["me"],
    ["spaces"],
    ["spaces", "s1", "folders"],
    ["spaces", "s1", "threads"],
    ["threads", "t1"],
  ])("keeps %j", (...queryKey) => {
    expect(shouldPersist(settled(queryClient, queryKey))).toBe(true);
  });

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

describe("cacheOwner", () => {
  const ada: CacheOwner = { userId: "u-ada", orgId: "o-last" };
  const offline = () => Promise.reject(new TypeError("Failed to fetch"));

  function owner(
    session: () => Promise<{ user: { id: string } } | null>,
    { tab = "o-tab" as string | null, last = ada as CacheOwner | null } = {},
  ) {
    let askedForOrg = false;
    const result = cacheOwner({
      session,
      org: () => {
        askedForOrg = true;
        return Promise.resolve(tab ?? "o-server");
      },
      tabOrg: () => tab,
      last: () => Promise.resolve(last ?? undefined),
    });
    return result.then((found) => ({ found, askedForOrg }));
  }

  it("is the signed-in user, in the tab's org", async () => {
    expect(await owner(() => Promise.resolve({ user: { id: "u-grace" } }))).toEqual({
      found: { userId: "u-grace", orgId: "o-tab" },
      askedForOrg: true,
    });
  });

  it("is nobody once the server says no one is signed in", async () => {
    expect((await owner(() => Promise.resolve(null))).found).toBeNull();
  });

  it("is nobody when the server answers the session with an error", async () => {
    const refused = () => Promise.reject(new Error("Unauthorized"));
    expect((await owner(refused)).found).toBeNull();
  });

  it("is whoever signed in last when the server cannot be reached, in the tab's org", async () => {
    expect(await owner(offline)).toEqual({
      found: { userId: "u-ada", orgId: "o-tab" },
      askedForOrg: false,
    });
  });

  it("takes the org they were in when the tab knows none", async () => {
    expect((await owner(offline, { tab: null })).found).toEqual(ada);
  });

  it("is nobody offline when no one signed in here before", async () => {
    expect((await owner(offline, { last: null })).found).toBeNull();
  });
});
