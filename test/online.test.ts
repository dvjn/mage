import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FIRST_CHECK_MS, LONGEST_CHECK_MS, serverReachability } from "@/web/lib/online.ts";

const noAnswer = () => Promise.reject(new TypeError("Failed to fetch"));
const answer = (status: number) => () => Promise.resolve(new Response(null, { status }));

describe("serverReachability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function reachability(ask: () => Promise<unknown> = answer(200)) {
    const changes: boolean[] = [];
    const asked = vi.fn(ask);
    const server = serverReachability(asked, (reachable) => changes.push(reachable));
    return { server, changes, asked };
  }

  it("is unreachable once a request gets no answer", async () => {
    const { server, changes } = reachability();
    await expect(server.follow(noAnswer)("/api/v1/me")).rejects.toThrow(TypeError);
    expect(server.reachable()).toBe(false);
    expect(changes).toEqual([false]);
  });

  it("stays reachable when the server answers with an error", async () => {
    const { server, changes } = reachability();
    const res = await server.follow(answer(500))("/api/v1/me");
    expect(res.status).toBe(500);
    expect(server.reachable()).toBe(true);
    expect(changes).toEqual([]);
  });

  it("stays reachable when a request is aborted", async () => {
    const { server } = reachability();
    const aborted = () => Promise.reject(new DOMException("aborted", "AbortError"));
    await expect(server.follow(aborted)("/api/v1/me")).rejects.toThrow("aborted");
    expect(server.reachable()).toBe(true);
  });

  it("is reachable again once a check is answered", async () => {
    const { server, changes, asked } = reachability(answer(200));
    await server
      .follow(noAnswer)("/api/v1/me")
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(server.reachable()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it("is reachable again once any request is answered", async () => {
    const { server, changes, asked } = reachability(noAnswer);
    await server
      .follow(noAnswer)("/api/v1/me")
      .catch(() => {});
    await server.follow(answer(200))("/api/v1/me");
    expect(changes).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(LONGEST_CHECK_MS);
    expect(asked).not.toHaveBeenCalled();
  });

  it("checks less often each time, up to the longest wait", async () => {
    const { server, asked } = reachability(noAnswer);
    await server
      .follow(noAnswer)("/api/v1/me")
      .catch(() => {});
    const waits = [FIRST_CHECK_MS, 4000, 8000, 16_000, LONGEST_CHECK_MS, LONGEST_CHECK_MS];
    for (const [index, wait] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(asked).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(asked).toHaveBeenCalledTimes(index + 1);
    }
    expect(server.reachable()).toBe(false);
  });

  it("checks at once when asked again, from the first wait", async () => {
    const { server, asked } = reachability(noAnswer);
    await server
      .follow(noAnswer)("/api/v1/me")
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + 4000);
    expect(asked).toHaveBeenCalledTimes(2);
    server.checkAgain();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(asked).toHaveBeenCalledTimes(4);
  });

  it("says whether the server answered a check, asking once for many", async () => {
    const { server, asked } = reachability(noAnswer);
    expect(await Promise.all([server.check(), server.check()])).toEqual([false, false]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(server.reachable()).toBe(false);
  });
});
