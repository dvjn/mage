import { describe, expect, it } from "vite-plus/test";

import { shortTimeAgo } from "@/web/lib/time.ts";

const now = Date.parse("2026-10-24T12:00:00.000Z");

function ago(seconds: number) {
  return new Date(now - seconds * 1000).toISOString();
}

describe("a moment in a few characters", () => {
  it("counts the largest whole unit that fits, and says now for under a minute", () => {
    expect(shortTimeAgo(ago(0), now)).toBe("now");
    expect(shortTimeAgo(ago(59), now)).toBe("now");
    expect(shortTimeAgo(ago(60), now)).toBe("1m");
    expect(shortTimeAgo(ago(59 * 60), now)).toBe("59m");
    expect(shortTimeAgo(ago(3 * 3600 + 1800), now)).toBe("3h");
    expect(shortTimeAgo(ago(2 * 86400), now)).toBe("2d");
    expect(shortTimeAgo(ago(20 * 86400), now)).toBe("2w");
    expect(shortTimeAgo(ago(100 * 86400), now)).toBe("3mo");
    expect(shortTimeAgo(ago(800 * 86400), now)).toBe("2y");
  });

  it("never looks ahead", () => {
    expect(shortTimeAgo(ago(-30), now)).toBe("now");
  });
});
