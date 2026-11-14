// Which moves the input machine allows from each state.

import { describe, expect, it } from "vite-plus/test";

import { inputMachine } from "./schema.ts";

describe("an input's machine", () => {
  it("moves only a waiting input, to taken in, taken back or dropped", () => {
    const allowed = inputMachine.states.flatMap((state) =>
      (["admit", "withdraw", "drop"] as const)
        .filter((event) => inputMachine.allows(event, state))
        .map((event) => `${event} from ${state}`),
    );
    expect(allowed).toEqual(["admit from waiting", "withdraw from waiting", "drop from waiting"]);
    expect(inputMachine.to("admit")).toEqual({ status: "admitted" });
    expect(inputMachine.to("withdraw")).toEqual({ status: "withdrawn" });
    expect(inputMachine.to("drop")).toEqual({ status: "dropped" });
  });
});
