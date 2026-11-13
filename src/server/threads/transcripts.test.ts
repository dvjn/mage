import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";

import { createTranscripts } from "./transcripts.ts";

describe("transcripts", () => {
  it("fold a held thread afresh when a write they read inside is rolled back", async () => {
    const { threadStore, log, thread, ada, post } = await agentThread();
    const transcripts = createTranscripts(threadStore);
    const release = transcripts.hold(thread.id);
    const texts = () =>
      transcripts
        .of(thread.id)
        .transcript()
        .pending.map((message) => message.text);
    await post(ada, "kept");
    expect(() =>
      log.write(thread.id, (append) => {
        append({
          type: "message",
          actor: { kind: "user", userId: ada.userId },
          data: { parts: [{ type: "text", text: "rolled back" }], quiet: false, mode: "steer" },
        });
        expect(texts()).toEqual(["kept", "rolled back"]);
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    await post(ada, "after");
    const fresh = createTranscripts(threadStore).of(thread.id).transcript();
    expect(transcripts.of(thread.id).transcript()).toEqual(fresh);
    expect(texts()).not.toContain("rolled back");
    release();
  });
});
