import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";

import { machine } from "./machine.ts";

const door = machine({
  states: ["open", "closed", "locked"],
  transitions: {
    close: { from: ["open"], to: "closed" },
    lock: { from: ["closed"], to: "locked" },
    open: { from: ["closed", "locked"], to: "open" },
  },
});

const table = pgTable("door", { status: text("status").notNull() });
const dialect = new PgDialect();

describe("machines", () => {
  it("allow an event only from the states it moves from", () => {
    const allowed = (["close", "lock", "open"] as const).flatMap((event) =>
      door.states.filter((state) => door.allows(event, state)).map((state) => `${event} ${state}`),
    );
    expect(allowed).toEqual(["close open", "lock closed", "open closed", "open locked"]);
  });

  it("give the condition an update moves rows from, and what it sets", () => {
    expect(dialect.sqlToQuery(door.from("open", table.status))).toMatchObject({
      sql: '"door"."status" in ($1, $2)',
      params: ["closed", "locked"],
    });
    expect(door.to("lock")).toEqual({ status: "locked" });
  });

  it("refuse a transition that names no state", () => {
    expect(() =>
      machine({ states: ["a"], transitions: { go: { from: ["a"], to: "b" as "a" } } }),
    ).toThrow("names b");
  });
});
