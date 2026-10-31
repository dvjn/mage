import { describe, expect, it } from "vite-plus/test";

import { transcriptOf } from "@/shared/transcript.ts";
import { setup } from "@/server/testing/workspace.ts";

import { eventSummary } from "./log.ts";
import { cleanTitle } from "./titles.ts";

async function titledThread() {
  const workspace = setup({}, { titles: true });
  workspace.org.defaultModel = "codex/gpt-big";
  const ada = await workspace.signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  async function post(text: string) {
    await workspace.api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text });
  }
  function title() {
    return workspace.threadStore.find(thread.id)?.title;
  }
  function events() {
    return workspace.threadStore.eventsAfter(thread.id, 0).map(eventSummary);
  }
  // Resolves once the thread's naming is done with.
  async function settled() {
    for (let tries = 0; tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  return { ...workspace, ada, thread, post, title, events, settled };
}

describe("thread titles", () => {
  it("name the thread after its first message, with the tokens counted in the thread", async () => {
    const { titleModel, post, title, events, settled } = await titledThread();

    await post("How do **engines** compute?");
    expect(title()).toBe("How do engines compute?");
    const call = await titleModel.next();
    call.startStep();
    call.delta('"Engines and ');
    call.delta('gears."');
    call.endStep({ inputTokens: 30, outputTokens: 4 });
    call.end();
    await settled();

    expect(call.texts).toEqual(["user: How do **engines** compute?"]);
    expect(call.request).toMatchObject({ maxSteps: 1, effort: "low" });
    expect(title()).toBe("Engines and gears");
    expect(events().at(-1)).toMatchObject({
      type: "thread.renamed",
      actor: { kind: "agent" },
      data: { title: "Engines and gears", usage: { inputTokens: 30, outputTokens: 4 } },
    });
    expect(transcriptOf(events()).usage).toEqual({ inputTokens: 30, outputTokens: 4 });
  });

  it("are asked for only after the first message", async () => {
    const { titleModel, post, settled } = await titledThread();

    await post("First");
    (await titleModel.next()).reply("One");
    await settled();
    await post("Second");
    await settled();

    expect(titleModel.calls).toHaveLength(1);
  });

  it("never replace a title a person gave", async () => {
    const { ada, api, thread, titleModel, post, title, events, settled } = await titledThread();

    await post("How do engines compute?");
    const call = await titleModel.next();
    await api("PATCH", `/threads/${thread.id}`, ada.cookie, { title: "Mine" });
    call.reply("Engines");
    await settled();

    expect(title()).toBe("Mine");
    expect(events().map((event) => event.type)).not.toContain("thread.renamed");
  });

  it("leave the title from the message when the model fails", async () => {
    const { titleModel, post, title, events, settled } = await titledThread();

    await post("How do engines compute?");
    (await titleModel.next()).fail("429");
    await settled();

    expect(title()).toBe("How do engines compute?");
    expect(events().map((event) => event.type)).not.toContain("thread.renamed");
  });

  it("use the org's title model, else the automatic one, else the thread's model", async () => {
    const { org, titleModel, titledWith, signUp, yourSpace, createThread, api, settled } =
      await titledThread();
    const grace = await signUp("Grace Hopper", "grace@example.com");
    const space = await yourSpace(grace.cookie);
    async function nameOne() {
      const thread = await createThread(grace.cookie, space.id);
      await api("POST", `/threads/${thread.id}/messages`, grace.cookie, { text: "Hi" });
      (await titleModel.next()).reply("Hi");
      await settled();
    }

    await nameOne();
    org.automaticTitleModel = "claude/claude-haiku-5-5";
    await nameOne();
    org.titleModel = "codex/gpt-mini";
    await nameOne();

    expect(titledWith).toEqual(["codex/gpt-big", "claude/claude-haiku-5-5", "codex/gpt-mini"]);
  });
});

describe("cleanTitle", () => {
  it("takes the first line without a label, quotes, markdown or a full stop", () => {
    expect(cleanTitle('\n  Title: "Engines **and** gears."\nMore')).toBe("Engines and gears");
    expect(cleanTitle("   ")).toBe("");
  });
});
