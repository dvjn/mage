// Server instances on one real Postgres database, each a workspace with connections, an instance
// id, a clock and outside ports of its own, which a test can kill, freeze, deafen, cut off from
// what it hears or stall before it, as a process can die, hang or lose its network. A killed
// instance reaches nothing after: its connections are ended at the server and every statement it
// tries is refused, its periodic work is dropped without its stop paths, and a call it makes out
// is left hanging. A test fails as it ends when a killed instance called out after it died.

import { createServer, connect, type Server, type Socket } from "node:net";

import { sql } from "drizzle-orm";
import { afterEach, expect } from "vite-plus/test";

import type { Listen } from "@/server/sync/sync.ts";

import { agentThread } from "./agent-thread.ts";
import { openTestDatabase, type TestDatabase } from "./database.ts";
import { setup } from "./workspace.ts";

// What the kit knows of an instance beyond its workspace.
interface State {
  name: string;
  database: TestDatabase;
  proxy: Proxy;
  deaf: boolean;
  // What it was sent while deaf.
  dropped: number;
  dead: boolean;
  // Calls out made once dead.
  calledAfter: number;
  frozen: { held: Promise<void>; thaw: () => void } | null;
  retire: () => void;
  stopSync: () => Promise<void>;
}

const states = new WeakMap<object, State>();
const made = new Set<State>();

afterEach(async () => {
  const all = [...made];
  made.clear();
  for (const state of all) state.frozen?.thaw();
  expect(all.map((state) => [state.name, state.calledAfter])).toEqual(
    all.map((state) => [state.name, 0]),
  );
  await Promise.all(all.map(async (state) => state.proxy.close()));
});

// A pass-through TCP proxy before one listening connection, which can stop passing anything on
// while keeping both sides open, as a stalled network does.
interface Proxy {
  port: number;
  stall(connecting?: number): void;
  close(): Promise<void>;
}

async function proxyTo(host: string, port: number): Promise<Proxy> {
  // The connections open now, each with whether it still passes anything on.
  const pairs = new Set<{ stalled: boolean; sockets: Socket[] }>();
  // How many connections still to be made stall from their start.
  let stallingNext = 0;
  const server: Server = createServer((client) => {
    const upstream = connect(port, host);
    const pair = { stalled: stallingNext > 0, sockets: [client, upstream] };
    if (pair.stalled) stallingNext -= 1;
    pairs.add(pair);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      from.on("data", (data) => {
        if (!pair.stalled) to.write(data);
      });
      from.on("error", () => {});
      from.on("close", () => {
        pairs.delete(pair);
        to.destroy();
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    // Those open now stop passing anything on, as do the next `connecting` made; one made after
    // passes as usual.
    stall(connecting = 0) {
      for (const pair of pairs) pair.stalled = true;
      stallingNext = connecting;
    },
    async close() {
      for (const pair of pairs) for (const socket of pair.sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// The instance's way out: waits while it is frozen, and never answers once it is dead.
function outsideOf(state: () => State) {
  return async () => {
    const now = state();
    if (now.dead) {
      now.calledAfter += 1;
      return new Promise<void>(() => {});
    }
    await now.frozen?.held;
  };
}

// What the instance hears, dropped while it is deaf; no gap is told.
function deafenable(listen: Listen, state: () => State): Listen {
  const heard: Listen = async (channel, onMessage, onGap) =>
    listen(
      channel,
      (payload) => {
        if (!state().deaf) onMessage(payload);
        else state().dropped += 1;
      },
      onGap,
    );
  if (listen.check) heard.check = async () => listen.check?.();
  return heard;
}

async function prepared(base: TestDatabase, name: string) {
  const connections = base.connections!;
  const proxy = await proxyTo(connections.server.host, connections.server.port);
  const database = connections.another(name, proxy.port);
  let state: State | undefined;
  const current = () => state!;
  return {
    database: { ...database, listen: deafenable(database.listen, current) },
    outside: outsideOf(current),
    made<W extends { retire(): void; sync: { stop(): Promise<void> } }>(workspace: W): W {
      state = {
        name,
        database,
        proxy,
        deaf: false,
        dropped: 0,
        dead: false,
        calledAfter: 0,
        frozen: null,
        retire: () => workspace.retire(),
        stopSync: async () => workspace.sync.stop(),
      };
      states.set(workspace, state);
      made.add(state);
      return workspace;
    },
  };
}

export type AgentInstance = Awaited<ReturnType<typeof agentThread>>;
export type Instance = ReturnType<typeof setup>;

// What each instance is set up with beside its own database and ports.
type Shared = Pick<NonNullable<Parameters<typeof setup>[1]>, "toolsets" | "fetch"> & {
  worker?: Parameters<typeof setup>[0];
};

// `n` instances on one new database: the first with a thread in Ada's space, as `agentThread`
// makes it, the others bare. Real Postgres only.
export async function instances(n: 1, shared?: Shared): Promise<[AgentInstance]>;
export async function instances(n: 2, shared?: Shared): Promise<[AgentInstance, Instance]>;
export async function instances(
  n: 3,
  shared?: Shared,
): Promise<[AgentInstance, Instance, Instance]>;
export async function instances(
  n: number,
  shared?: Shared,
): Promise<[AgentInstance, ...Instance[]]>;
export async function instances(
  n: number,
  { worker = {}, ...shared }: Shared = {},
): Promise<[AgentInstance, ...Instance[]]> {
  if (!process.env.TEST_DATABASE_URL) throw new Error("Instances need a real Postgres.");
  const base = openTestDatabase();
  const first = await prepared(base, "i0");
  const a = first.made(
    await agentThread(worker, { ...shared, database: first.database, outside: first.outside }),
  );
  const rest: Instance[] = [];
  for (let index = 1; index < n; index += 1) {
    const next = await prepared(base, `i${index}`);
    rest.push(
      next.made(setup(worker, { ...shared, database: next.database, outside: next.outside })),
    );
  }
  return [a, ...rest];
}

function stateOf(instance: object) {
  const state = states.get(instance);
  if (!state) throw new Error("Not an instance the kit made.");
  return state;
}

// Kills the instance as a process dies: nothing of it runs again and nothing it holds is let go
// by it. Its connections end at the server, as Postgres sees a process die.
export async function kill(instance: object) {
  const state = stateOf(instance);
  state.dead = true;
  state.retire();
  // Clears its timers and stops listening; nothing it stops writes, its statements being refused.
  void state.stopSync().catch(() => {});
  await state.database.connections!.end();
  state.frozen?.thaw();
}

// Stops the instance without killing it: its statements wait, so its leases go unrenewed, and its
// calls out wait, until it thaws.
export function freeze(instance: object) {
  const state = stateOf(instance);
  if (state.frozen) return;
  let thaw = () => {};
  const held = new Promise<void>((resolve) => (thaw = resolve));
  state.frozen = { held, thaw };
  state.database.connections!.hold(held);
}

export function thaw(instance: object) {
  const state = stateOf(instance);
  state.database.connections!.hold(null);
  state.frozen?.thaw();
  state.frozen = null;
}

// The instance hears nothing the others signal, and is not told it missed anything, until
// restored.
export function deafen(instance: object) {
  stateOf(instance).deaf = true;
}

export function restore(instance: object) {
  stateOf(instance).deaf = false;
}

// How many signals reached the instance while it was deaf, and were dropped.
export function dropped(instance: object) {
  return stateOf(instance).dropped;
}

// Ends the instance's listening connection at the server; it connects again and tells of the gap.
export async function dropListener(instance: object) {
  await stateOf(instance).database.connections!.endListener();
}

// What the instance hears on its listening connection stops passing, the connection left open, as
// does all on the next `connecting` listening connections it makes; one it makes after passes as
// usual.
export function stall(instance: object, { connecting = 0 } = {}) {
  stateOf(instance).proxy.stall(connecting);
}

// Holds the thread's row lock from a connection of the test's own, as the writes that lock the
// thread wait behind it; answers how to let it go.
export async function lockThread(instance: object, threadId: string) {
  const { db } = stateOf(instance).database.of!;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked = () => {};
  const locking = new Promise<void>((resolve) => (locked = resolve));
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`select id from thread where id = ${threadId} for update`);
    locked();
    await held;
  });
  await Promise.race([locking, done]);
  return async () => {
    release();
    await done;
  };
}
