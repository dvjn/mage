import { describe, expect, it } from "vite-plus/test";

import { agentTurnOf, type TranscriptRow } from "@/shared/transcript.ts";

const row = (kind: string, extra: object = {}) => ({ kind, id: kind, ...extra }) as TranscriptRow;
const human = row("human");
const tool = row("tool");
const words = row("agent", { status: "completed", text: "Done", reasoning: null, model: "a/b" });
const thinking = row("agent", { status: "streaming", text: "", reasoning: "Hm", model: "a/c" });
const callsOnly = row("agent", { status: "completed", text: "", reasoning: null, model: "a/d" });

describe("agentTurnOf", () => {
  it("opens a turn with a call after a person's message or at the start", () => {
    expect(agentTurnOf([tool], 0)?.continued).toBe(false);
    expect(agentTurnOf([human, tool], 1)?.continued).toBe(false);
    expect(agentTurnOf([human, callsOnly, tool], 2)?.continued).toBe(false);
  });

  it("opens a turn with a reply after a person's message", () => {
    expect(agentTurnOf([human, words], 1)).toEqual({ continued: false, model: "a/b" });
    expect(agentTurnOf([human, thinking], 1)).toEqual({ continued: false, model: "a/c" });
  });

  it("continues a turn after the agent's words or a call, past a step that only called tools", () => {
    expect(agentTurnOf([human, words, tool], 2)?.continued).toBe(true);
    expect(agentTurnOf([human, tool, tool], 2)?.continued).toBe(true);
    expect(agentTurnOf([human, tool, callsOnly, tool], 3)?.continued).toBe(true);
    expect(agentTurnOf([human, tool, words], 2)?.continued).toBe(true);
  });

  it("names the model of the turn's reply from its first call", () => {
    expect(agentTurnOf([human, callsOnly, tool, tool, words], 2)?.model).toBe("a/b");
    expect(agentTurnOf([human, callsOnly, tool, tool, words], 3)?.model).toBe("a/b");
    expect(agentTurnOf([human, callsOnly, tool, thinking], 2)?.model).toBe("a/c");
  });

  it("has no model for a turn whose reply has not begun or that a person's message ends", () => {
    expect(agentTurnOf([human, callsOnly, tool], 2)?.model).toBeNull();
    expect(agentTurnOf([human, tool, human, words], 1)?.model).toBeNull();
    expect(agentTurnOf([human, tool, row("failure")], 1)?.model).toBeNull();
  });

  it("is null for a person's message, a step that only called tools, and the rest", () => {
    expect(agentTurnOf([human, words], 0)).toBeNull();
    expect(agentTurnOf([human, callsOnly, tool], 1)).toBeNull();
    expect(agentTurnOf([human, row("failure")], 1)).toBeNull();
    expect(agentTurnOf([human, row("stop")], 1)).toBeNull();
    expect(agentTurnOf([human], 1)).toBeNull();
  });
});
