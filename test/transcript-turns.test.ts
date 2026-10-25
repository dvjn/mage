import { describe, expect, it } from "vite-plus/test";

import { opensAgentTurn, type TranscriptRow } from "@/shared/transcript.ts";

const row = (kind: string, extra: object = {}) => ({ kind, id: kind, ...extra }) as TranscriptRow;
const human = row("human");
const tool = row("tool");
const words = row("agent", { status: "completed", text: "Done", reasoning: null });
const callsOnly = row("agent", { status: "completed", text: "", reasoning: null });

describe("opensAgentTurn", () => {
  it("is true for a call after a person's message or at the start", () => {
    expect(opensAgentTurn([tool], 0)).toBe(true);
    expect(opensAgentTurn([human, tool], 1)).toBe(true);
    expect(opensAgentTurn([human, callsOnly, tool], 2)).toBe(true);
  });

  it("is false for a call after the agent's words or another call", () => {
    expect(opensAgentTurn([human, words, tool], 2)).toBe(false);
    expect(opensAgentTurn([human, tool, tool], 2)).toBe(false);
    expect(opensAgentTurn([human, tool, callsOnly, tool], 3)).toBe(false);
  });

  it("is false for rows that are not calls", () => {
    expect(opensAgentTurn([human, words], 1)).toBe(false);
  });
});
