import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";

import { createTranscripts } from "./transcripts.ts";

describe("transcripts", () => {
  it("fold a held thread afresh when a write they read inside is rolled back", async () => {
    const { threadStore, log, thread, ada, post } = await agentThread();
    const transcripts = createTranscripts(threadStore);
    const release = transcripts.hold(thread.id);
    const texts = async () =>
      (await transcripts.of(thread.id)).waiting().messages.map((message) => message.text);
    await post(ada, "kept");
    await expect(
      log.write(thread.id, async (append) => {
        await append({
          type: "message",
          actor: { kind: "user", userId: ada.userId },
          data: { parts: [{ type: "text", text: "rolled back" }], quiet: false, mode: "steer" },
        });
        expect(await texts()).toEqual(["kept", "rolled back"]);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    await post(ada, "after");
    const fresh = await createTranscripts(threadStore).of(thread.id);
    const held = await transcripts.of(thread.id);
    expect(held.transcript()).toEqual(fresh.transcript());
    expect(held.waiting()).toEqual(fresh.waiting());
    expect(await texts()).not.toContain("rolled back");
    release();
  });
});
