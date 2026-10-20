import { describe, expect, it } from "vite-plus/test";

import { createApp } from "@/http/app.ts";

describe("GET /api/health", () => {
  it("reports ok", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
