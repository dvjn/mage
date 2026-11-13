import { describe, expect, it } from "vite-plus/test";

import type { ModelEvent } from "@/server/models/gateway.ts";
import { ModelError } from "@/server/models/gateway.ts";

import { createFakeGateway } from "./fake-gateway.ts";
import { type ScriptRequest, scriptStep } from "./fake-script.ts";

function step(text: string, more: Partial<ScriptRequest> = {}) {
  return scriptStep({
    instructions: "Be brief.",
    messages: [{ role: "user", text }],
    offered: new Set(["notes.add", "tools.search"]),
    search: "tools.search",
    ...more,
  });
}

describe("the stand-in model's script", () => {
  it("says how many messages it read, then a few words", () => {
    const said = step("Hello");
    expect(said.text.join("")).toBe(
      "I have read 1 message, and so the engine turns its wheels and",
    );
    expect(said.calls).toEqual([]);
    expect(said.reasoning).toEqual([]);
  });

  it("counts only people's words, not what it was given ahead of them", () => {
    const said = scriptStep({
      instructions: "",
      messages: [
        { role: "user", text: "Context" },
        { role: "user", text: "Hi" },
      ],
      offered: new Set(),
      search: "tools.search",
      isLead: (message) => message.role === "user" && message.text === "Context",
    });
    expect(said.text.join("")).toContain("I have read 1 message,");
  });

  it("calls an offered tool a line asks for, by its id and its name in the request", () => {
    const said = step('[Ada Lovelace] ^tool notes.add {"title":"Looms"}', {
      nameOf: (id) => id.replace(".", "__"),
      offered: new Set(["notes__add"]),
    });
    expect(said.calls).toEqual([
      { toolId: "notes.add", toolName: "notes__add", input: { title: "Looms" } },
    ]);
  });

  it("selects tools it is not offered with the tool search, or says it cannot use them", () => {
    expect(step("^tool looms.weave {}").calls).toEqual([
      { toolId: "tools.search", toolName: "tools.search", input: { select: ["looms.weave"] } },
    ]);
    const without = step("^tool looms.weave {}", { offered: new Set() });
    expect(without.calls).toEqual([]);
    expect(without.text.join("")).toContain("I cannot use looms.weave here.");
  });

  it("does not take a slash line as a steering line", () => {
    expect(step("/tool notes.add {}").calls).toEqual([]);
  });

  it("reads the steering lines for failing, refusing, stalling and dropping", () => {
    expect(step("^fail Jammed").fail).toBe("Jammed");
    expect(step("^status 429 retry-after=3 Slow down").status).toEqual({
      code: 429,
      retryAfter: 3,
      message: "Slow down",
    });
    expect(step("^status 503").status).toEqual({
      code: 503,
      retryAfter: null,
      message: "Refused with 503",
    });
    expect(step("^stall 250").stall).toBe(250);
    expect(step("^drop").drop).toBe(true);
  });

  it("says its prompt, or the rest of a say line, in place of its words", () => {
    expect(step("^prompt").text.join("")).toBe("Be brief.");
    expect(step("^say\nPunched cards.").text.join("")).toBe("Punched cards.");
  });

  it("thinks first when asked to", () => {
    expect(step("Think about it").reasoning.join("")).toBe("Considering the gears and the levers");
  });
});

describe("the in-process stand-in model", () => {
  async function run(text: string) {
    const events: ModelEvent[] = [];
    const stream = createFakeGateway().stream(
      { access: "", accountId: null },
      {
        model: "echo",
        instructions: "",
        messages: [{ role: "user", text }],
        maxSteps: 1,
        sessionId: "s",
      },
      new AbortController().signal,
    );
    try {
      for await (const event of stream) events.push(event);
    } catch (err) {
      return { events, err };
    }
    return { events, err: null };
  }

  it("refuses as a provider would, sorted by its status", async () => {
    const { events, err } = await run("^status 429 retry-after=60 Slow down");
    expect(events).toEqual([]);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe("limit");
    expect((err as ModelError).resetsAt).not.toBeNull();
  });

  it("drops after its words, as a lost connection", async () => {
    const { events, err } = await run("^drop");
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect((err as ModelError).kind).toBe("network");
  });
});
