// A status column's machine: its states and which event moves a row from which states to which.
// The table becomes a CHECK on the column, a condition for each guarded update's WHERE and the
// value for its SET, so the database refuses a state that does not exist and an update from a
// state the event does not leave changes no row.

import { inArray, type SQL } from "drizzle-orm";
import { check, type PgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export interface Machine<S extends string, E extends string> {
  states: readonly S[];
  // The CHECK that keeps the column to the states, for the table's definition.
  check(name: string, column: PgColumn): ReturnType<typeof check>;
  // The rows the event may move: those in one of its states to move from.
  from(event: E, column: PgColumn): SQL;
  // What the event sets.
  to(event: E): { status: S };
  // Whether the event moves a row in the state.
  allows(event: E, state: S): boolean;
}

export function machine<S extends string, E extends string>(def: {
  states: readonly S[];
  transitions: Record<E, { from: readonly S[]; to: S }>;
}): Machine<S, E> {
  for (const [event, { from, to }] of Object.entries(def.transitions) as [
    E,
    { from: readonly S[]; to: S },
  ][]) {
    for (const state of [...from, to]) {
      if (!def.states.includes(state)) throw new Error(`${event} names ${state}, not a state.`);
    }
  }
  return {
    states: def.states,
    check: (name, column) =>
      check(
        name,
        sql`${column} in (${sql.join(
          def.states.map((state) => sql.raw(`'${state.replaceAll("'", "''")}'`)),
          sql`, `,
        )})`,
      ),
    from: (event, column) => inArray(column, [...def.transitions[event].from]),
    to: (event) => ({ status: def.transitions[event].to }),
    allows: (event, state) => def.transitions[event].from.includes(state),
  };
}
