import { describe, expect, it, vi } from "vite-plus/test";

// Each test reads the module afresh, as a page that has just loaded.
async function fresh() {
  vi.resetModules();
  return import("@/web/lib/tracing.ts");
}

describe("web tracing", () => {
  it("loads nothing while the server does not trace, and actions run as they are", async () => {
    const tracing = await fresh();
    const load = vi.fn(() => Promise.reject(new Error("loaded")));
    tracing.startTracing(undefined, load);
    tracing.startTracing(false, load);
    expect(load).not.toHaveBeenCalled();
    await expect(tracing.traced("send message", "t1", () => Promise.resolve(7))).resolves.toBe(7);
    tracing.runShown("t1", { id: "r1", waiting: null, trace: "00-x-y-01" });
    tracing.pieceShown("t1", "text");
  });

  it("loads tracing once the server says it traces, and only once", async () => {
    const tracing = await fresh();
    const start = vi.fn();
    const load = vi.fn(() => Promise.resolve({ start } as never));
    tracing.startTracing(true, load);
    tracing.startTracing(true, load);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
