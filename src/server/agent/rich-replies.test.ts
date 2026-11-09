import { describe, expect, it } from "vite-plus/test";

import { artifactIdsIn, LAYOUT_COMPONENTS, messageOf, outcomeOf } from "@/web/replies/reply-layout";
import { splitReply } from "@/web/replies/reply-blocks";
import { agentThread } from "@/server/testing/agent-thread.ts";

import { RICH_REPLIES_GUIDANCE, RICH_REPLIES_TOOLSET } from "./rich-replies.ts";

const LAYOUT = `root = Stack([summary, more])
summary = Card("Q3", [row])
row = Row([s1])
s1 = Stat("Revenue", "$1.2M", "+4%")
more = Button("Show March", @ToAssistant("Show March in detail"))`;

describe("reply blocks", () => {
  it("split a reply into Markdown and its ui blocks, the last still open while it streams", () => {
    expect(splitReply("Just words")).toEqual([{ kind: "markdown", text: "Just words" }]);
    expect(splitReply(`Before\n\n\`\`\`ui\n${LAYOUT}\n\`\`\`\nAfter`)).toEqual([
      { kind: "markdown", text: "Before\n" },
      { kind: "ui", source: LAYOUT, open: false },
      { kind: "markdown", text: "After" },
    ]);
    expect(splitReply("Here:\n```ui\nroot = Stack([")).toEqual([
      { kind: "markdown", text: "Here:" },
      { kind: "ui", source: "root = Stack([", open: true },
    ]);
  });

  it("leave other code and a ui fence inside other code as Markdown", () => {
    const text = "```ts\nconst a = 1;\n```\n\n````md\n```ui\nx\n```\n````";
    expect(splitReply(text)).toEqual([{ kind: "markdown", text }]);
  });
});

describe("reply layouts", () => {
  it("draw a layout written as the guidance says", () => {
    expect(outcomeOf(LAYOUT)).toEqual({ drawn: true, problems: [] });
  });

  it("accept an Artifact(id) and find the ids a reply places", () => {
    const layout = 'root = Stack([card])\ncard = Artifact("a1")';
    expect(outcomeOf(layout)).toEqual({ drawn: true, problems: [] });
    expect(artifactIdsIn(`Done.\n\n\`\`\`ui\n${layout}\n\`\`\``)).toEqual(["a1"]);
    expect(artifactIdsIn('Artifact("a2") in prose')).toEqual([]);
  });

  it("draw the parts that work and name the rest", () => {
    const outcome = outcomeOf(
      `root = Stack([good, bad, gone])\ngood = Text("Fine")\nbad = Stat("Revenue")`,
    );
    expect(outcome.drawn).toBe(true);
    expect(outcome.problems.length).toBeGreaterThan(0);
    expect(outcome.problems.join("\n")).toContain("gone");
  });

  it("give nothing to draw for output that is not a layout", () => {
    for (const source of [
      "Sure! <div>hello</div>",
      '{"type":"Stack","children":[]}',
      'x = Text("no root")',
      "",
    ]) {
      expect(outcomeOf(source).drawn, source).toBe(false);
    }
  });

  it("turn a click into the clicker's message, with a form's values quoted, and nothing else", () => {
    expect(messageOf({ type: "continue_conversation", humanFriendlyMessage: "Show March" })).toBe(
      "Show March",
    );
    expect(
      messageOf({
        type: "continue_conversation",
        humanFriendlyMessage: "Book it",
        formName: "Booking",
        formState: {
          Booking: {
            Name: { value: "Ada", componentType: "Input" },
            Day: { value: "Tuesday", componentType: "Select" },
            Note: { value: "", componentType: "Input" },
          },
        },
      }),
    ).toBe("Book it\n> - Name: Ada\n> - Day: Tuesday");
    expect(messageOf({ type: "open_url", humanFriendlyMessage: "Go", formState: {} })).toBeNull();
  });
});

describe("rich replies guidance", () => {
  it("names every component, and its examples draw", () => {
    for (const { name } of LAYOUT_COMPONENTS) {
      expect(RICH_REPLIES_GUIDANCE).toContain(`${name}(`);
    }
    const example = splitReply(RICH_REPLIES_GUIDANCE).find((piece) => piece.kind === "ui");
    expect(example?.kind === "ui" && outcomeOf(example.source)).toEqual({
      drawn: true,
      problems: [],
    });
  });

  it("is always in the agent's prompt, whatever switch was stored for it", async () => {
    const { ada, post, model, worker, start, toolSettings, space } = await agentThread();
    start();
    await post(ada, "Hello");
    const on = await model.next();
    on.reply("Hi.");
    await worker.idle();
    expect(on.request.instructions).toContain("Rich replies:");

    toolSettings.setToolsetInSpace(space.id, RICH_REPLIES_TOOLSET, false);
    await post(ada, "Again");
    const off = await model.next();
    off.reply("Hi.");
    await worker.idle();
    expect(off.request.instructions).toContain("Rich replies:");
  });
});
