import { describe, expect, it } from "vite-plus/test";

import { type Work } from "@/shared/jobs.ts";

import { SOON_MS, attentionOf, liveFor, subagentStatus } from "./tray.ts";

const now = new Date("2026-11-12T10:00:00Z");

function work(fields: Partial<Work>): Work {
  return {
    kind: "job",
    status: "running",
    startedAt: "2026-11-12T09:00:00Z",
    canCancel: false,
    ...fields,
  };
}

describe("tray attention", () => {
  it("asks for a reader on approval, failure and a near firing", () => {
    expect(attentionOf(work({ status: "waiting", canDecide: true }), now)).toBe("approval");
    expect(attentionOf(work({ status: "waiting", canDecide: false }), now)).toBeUndefined();
    expect(attentionOf(work({ status: "waiting" }), now)).toBeUndefined();
    expect(attentionOf(work({ status: "failed" }), now)).toBe("failed");
    expect(attentionOf(work({ status: "interrupted" }), now)).toBe("failed");
    const next = (ms: number) =>
      work({
        kind: "schedule",
        status: "scheduled",
        schedule: {
          id: "s",
          kind: "cron",
          fired: 0,
          name: "n",
          canChange: true,
          nextRunAt: new Date(now.getTime() + ms).toISOString(),
        },
      });
    expect(attentionOf(next(SOON_MS - 1000), now)).toBe("soon");
    expect(attentionOf(next(SOON_MS * 2), now)).toBeUndefined();
    expect(attentionOf(work({ status: "running" }), now)).toBeUndefined();
  });
});

describe("subagent status", () => {
  it("waits on a person only while its call does, and a queued one needs nobody", () => {
    const queued = work({ kind: "subagent", status: subagentStatus("queued") });
    expect(queued.status).toBe("queued");
    expect(attentionOf(queued, now)).toBeUndefined();
    expect(liveFor(queued, undefined)).toBe(true);
    expect(subagentStatus("working", "decision")).toBe("waiting");
    expect(subagentStatus("working")).toBe("running");
    expect(subagentStatus("stopped")).toBe("cancelled");
  });
});

describe("tray liveness", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("keeps what is under way whatever was seen", () => {
    expect(liveFor(work({ status: "running" }), at("2026-11-12T09:59:00Z"))).toBe(true);
    expect(liveFor(work({ status: "listening" }), at("2026-11-12T09:59:00Z"))).toBe(true);
  });

  it("keeps an idle subagent whatever was seen, and no attention for it", () => {
    const idle = work({
      kind: "subagent",
      status: subagentStatus("idle"),
      endedAt: "2026-11-12T09:30:00Z",
      subagent: { threadId: "t", state: "idle" },
    });
    expect(liveFor(idle, at("2026-11-12T09:59:00Z"))).toBe(true);
    expect(attentionOf(idle, now)).toBeUndefined();
  });

  it("drops a job at once when it ends, whatever was seen", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      const job = work({ status, endedAt: "2026-11-12T09:30:00Z" });
      expect(liveFor(job, undefined)).toBe(false);
      expect(liveFor(job, at("2026-11-12T09:00:00Z"))).toBe(false);
    }
    expect(liveFor(work({ status: "waiting" }), undefined)).toBe(true);
  });

  it("keeps what else ended until its kind is seen after it ended", () => {
    const ended = work({
      kind: "schedule",
      status: "completed",
      endedAt: "2026-11-12T09:30:00Z",
    });
    expect(liveFor(ended, undefined)).toBe(true);
    expect(liveFor(ended, at("2026-11-12T09:00:00Z"))).toBe(true);
    expect(liveFor(ended, at("2026-11-12T09:31:00Z"))).toBe(false);
  });
});
