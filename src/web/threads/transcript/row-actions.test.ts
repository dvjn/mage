import { describe, expect, it, vi } from "vite-plus/test";

import type { ShownRow } from "@/shared/threads/rows.ts";
import { type RowActionHandlers, rowActions } from "@/web/threads/transcript/row-actions";

function handlers(overrides: Partial<RowActionHandlers> = {}): RowActionHandlers {
  return {
    retry: vi.fn(),
    decide: vi.fn(() => Promise.resolve()),
    answer: vi.fn(() => Promise.resolve()),
    edit: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const failure = { kind: "failure", id: "f", runId: "run-1", canRetry: true } as unknown as ShownRow;
const human = { kind: "human", id: "h", can: ["edit"] } as unknown as ShownRow;
const plain = { kind: "compaction", id: "c" } as unknown as ShownRow;

describe("rowActions", () => {
  it("gives a row the same actions object until the handlers change", () => {
    const actionsFor = rowActions(handlers());
    expect(actionsFor(failure)).toBe(actionsFor(failure));
    expect(rowActions(handlers())(failure)).not.toBe(actionsFor(failure));
  });

  it("calls the handlers with the row's own ids", async () => {
    const given = handlers();
    const actionsFor = rowActions(given);
    actionsFor(failure).retry?.();
    expect(given.retry).toHaveBeenCalledWith("run-1");
    await actionsFor(human).edit?.("again");
    expect(given.edit).toHaveBeenCalledWith("h", "again");
  });

  it("offers only what the row and the handlers allow", () => {
    expect(rowActions(handlers())(plain)).toEqual({});
    expect(rowActions(handlers())(failure).pickModel).toBeUndefined();
    const pickModel = vi.fn();
    expect(rowActions(handlers({ pickModel }))(plain).pickModel).toBe(pickModel);
  });
});
