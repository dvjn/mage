// Python run in Monty's sandbox, in worker processes from one pool, opened when first used. A
// script runs to its end under fixed limits, with nothing of the host but the functions it is
// given, each awaitable: a call starts on the host as it is made, so those a script gathers run
// at once, and is answered as the script awaits it. What it prints is gathered. Values cross as
// JSON. A stop kills its worker at once. A call may pause the script instead of answering: once
// every call it waits on waits so, it is dumped where it stands, to go on later in any worker
// with those calls answered there.

import {
  FunctionSnapshot,
  FutureSnapshot,
  Monty,
  MontyComplete,
  MontyCrashedError,
  MontyRuntimeError,
  type MontySession,
  MontySyntaxError,
  NameLookupSnapshot,
  type ResourceLimits,
  type Snapshot,
} from "@pydantic/monty";

// The limits every script runs under: memory, time (paused on the host is not counted) and calls
// of the host's functions.
export const SCRIPT_LIMITS = {
  maxMemory: 256 * 1024 * 1024,
  maxFeedDurationSecs: 60,
  maxSuspensions: 4000,
} satisfies ResourceLimits;

// The most calls a script makes, across every pause, well within the sandbox's own count of its
// turns, so this cap is the one a script meets.
export const SCRIPT_CALLS = 1000;

// The most of a script's calls that run at once; more wait their turn.
export const SCRIPT_PARALLEL = 8;

// How many scripts run at once on an instance, each in a worker of its own: at most this many
// times the memory limit.
export const SCRIPT_WORKERS = 4;

// How long a script waits for a worker while all are busy.
const CHECKOUT_SECS = 30;

// The most a paused script's dump may hold; one past it does not pause.
export const PAUSE_BYTES = 4 * 1024 * 1024;

// The most of what a script printed that is kept: its end.
export const PRINTED_CHARS = 20_000;

// An error a host function raises in the script, as the Python exception named.
export class PythonError extends Error {
  constructor(
    name: "NameError" | "PermissionError" | "RuntimeError" | "TypeError" | "ValueError",
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

// What a host function throws to pause the script at its call, carrying what it decided.
export class PythonPause extends Error {
  readonly detail: unknown;

  constructor(detail: unknown) {
    super("paused");
    this.detail = detail;
  }
}

// What a host call came to.
type Settled =
  | { value: unknown }
  | { error: PythonError }
  | { pause: unknown }
  | { fatal: unknown };

// Told to a script that made a call and never awaited it.
const UNAWAITED =
  "call_tool is awaitable: write `await call_tool(...)`, or gather several with asyncio.gather.";

// A function the script may call, given its arguments as JSON values.
export type HostFunction = (args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

export interface PythonRun {
  code: string;
  // Bound as the script's variables before it runs.
  inputs?: Record<string, unknown>;
  functions: Record<string, HostFunction>;
  print?: (text: string) => void;
  signal?: AbortSignal;
  // Where a paused script stood, what it had printed, and the outcome of each call it paused at,
  // by the sandbox's id for it, to go on from.
  resume?: { snapshot: Buffer; printed: string; answer: (future: number) => Promise<unknown> };
  // Hears of a pause refused as too large, with the error the call raises in its place.
  tooLarge?: (detail: unknown, error: PythonError) => Promise<void>;
}

export type PythonOutcome = (
  | { ok: true; value: unknown }
  | { ok: false; error: string }
  // Paused at the calls it waits on, with where it stood and what each call's function decided,
  // by the sandbox's id for the call.
  | { ok: false; paused: { snapshot: Buffer; calls: { future: number; detail: unknown }[] } }
) & {
  printed: string;
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

// A zone's offset as ISO 8601 has it.
function offsetText(seconds: number | undefined) {
  if (seconds === undefined) return "";
  if (seconds === 0) return "Z";
  const abs = Math.abs(seconds);
  return `${seconds < 0 ? "-" : "+"}${pad(Math.floor(abs / 3600))}:${pad(Math.floor(abs / 60) % 60)}`;
}

// Python's dates, times and durations in ISO 8601.
function isoOf(marked: Record<string, number | string | undefined> & { __monty_type__: string }) {
  const n = (key: string) => Number(marked[key] ?? 0);
  const date = () => `${pad(n("year"), 4)}-${pad(n("month"))}-${pad(n("day"))}`;
  const time = () =>
    `${pad(n("hour"))}:${pad(n("minute"))}:${pad(n("second"))}${n("microsecond") ? `.${pad(n("microsecond"), 6)}` : ""}${offsetText(marked.offsetSeconds as number | undefined)}`;
  switch (marked.__monty_type__) {
    case "Date":
      return date();
    case "DateTime":
      return `${date()}T${time()}`;
    case "Time":
      return time();
    case "TimeDelta":
      return `P${n("days")}DT${n("seconds") + n("microseconds") / 1e6}S`;
    case "Decimal":
      return marked.value;
    default:
      return undefined;
  }
}

// The value as JSON: dicts as objects, sets and tuples as lists, integers past JSON's as text,
// dates, times and durations as ISO 8601.
export function toJson(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [String(key), toJson(item)]));
  }
  if (value instanceof Set || Array.isArray(value)) return [...value].map(toJson);
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value === "object" && value !== null) {
    const marked = value as { __monty_type__?: unknown };
    if (typeof marked.__monty_type__ === "string") {
      const iso = isoOf(marked as Parameters<typeof isoOf>[0]);
      if (iso !== undefined) return iso;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
  }
  return value;
}

function messageOf(err: unknown) {
  if (err instanceof MontyRuntimeError || err instanceof MontySyntaxError) {
    return err.display("traceback");
  }
  return err instanceof Error ? err.message : String(err);
}

export type Python = ReturnType<typeof createPython>;

export function createPython(
  limits: ResourceLimits = SCRIPT_LIMITS,
  given: { workers?: number; checkoutSecs?: number; pauseBytes?: number; parallel?: number } = {},
) {
  const pooled = {
    parallel: given.parallel ?? SCRIPT_PARALLEL,
    workers: given.workers ?? SCRIPT_WORKERS,
    checkoutSecs: given.checkoutSecs ?? CHECKOUT_SECS,
    pauseBytes: given.pauseBytes ?? PAUSE_BYTES,
  };
  let pool: Promise<Monty> | null = null;

  return {
    async run(script: PythonRun): Promise<PythonOutcome> {
      const { signal } = script;
      let printed = script.resume?.printed ?? "";
      const print = (_stream: string, text: string) => {
        printed = (printed + text).slice(-PRINTED_CHARS);
        script.print?.(text);
      };
      const stopped = { ok: false as const, error: "The script was stopped.", printed };
      pool ??= Monty.create({
        maxProcesses: pooled.workers,
        checkoutTimeout: pooled.checkoutSecs,
      }).catch((err: unknown) => {
        pool = null;
        throw err;
      });
      const checkout = (await pool).checkout({ limits });
      const aborted = new Promise<null>((resolve) => {
        if (signal?.aborted) resolve(null);
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
      let session: MontySession | null;
      try {
        session = await Promise.race([checkout, aborted]);
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return {
            ok: false,
            error: "Too many scripts are running here; try again shortly.",
            printed,
          };
        }
        throw err;
      }
      if (!session) {
        // A worker that comes after the stop goes back at once.
        void checkout.then(async (late) => late.close()).catch(() => {});
        return stopped;
      }
      // Known only between turns, so read before the first.
      const pid = session.workerPid;
      const kill = () => {
        try {
          if (pid !== undefined) process.kill(pid, "SIGKILL");
        } catch {
          // It had exited already.
        }
      };
      signal?.addEventListener("abort", kill, { once: true });
      // Calls the script made and left behind, as one whose gather raised leaves the rest: each
      // ends as it does, and one that waits for a person never runs.
      let drain = async () => Promise.resolve();
      try {
        if (signal?.aborted) throw signal.reason;
        let snapshot: Snapshot;
        if (script.resume) {
          // Those watching see what it printed before it paused, then what it prints from here.
          if (script.resume.printed) script.print?.(script.resume.printed);
          try {
            snapshot = await session.loadSnapshot(script.resume.snapshot, { printCallback: print });
          } catch (err) {
            return { ok: false, error: `The script could not go on: ${messageOf(err)}`, printed };
          }
        } else {
          snapshot = await session.feedStart(script.code, {
            ...(script.inputs && { inputs: script.inputs }),
            printCallback: print,
          });
        }
        // Each host call starts as it is made and is answered once the script awaits it, so the
        // calls a script gathers run at once. What each came to, by the sandbox's id for it.
        const started = new Map<number, Promise<Settled>>();
        const settled = new Map<number, Settled>();
        const delivered = new Set<number>();
        // Places for calls running now, and the calls waiting for one.
        let running = 0;
        const turns: (() => void)[] = [];
        const turn = async () => {
          if (running >= pooled.parallel) await new Promise<void>((go) => turns.push(go));
          running += 1;
        };
        const done = () => {
          running -= 1;
          turns.shift()?.();
        };
        const start = (id: number, work: () => Promise<unknown>) => {
          const outcome = turn()
            .then(work)
            .finally(done)
            .then(
              (value): Settled => ({ value }),
              (err: unknown): Settled =>
                err instanceof PythonPause
                  ? { pause: err.detail }
                  : err instanceof PythonError
                    ? { error: err }
                    : { fatal: err },
            )
            .then((done) => {
              settled.set(id, done);
              return done;
            });
          started.set(id, outcome);
        };
        drain = async () => {
          const left = [...started.keys()].filter((id) => !delivered.has(id));
          await Promise.all(left.map(async (id) => started.get(id)));
        };
        if (script.resume) {
          // A script pauses only where it awaits its calls.
          if (!(snapshot instanceof FutureSnapshot)) {
            return { ok: false, error: "The script could not go on from where it stood.", printed };
          }
          const { answer } = script.resume;
          for (const id of snapshot.pendingCallIds) start(id, async () => answer(id));
        }
        while (!(snapshot instanceof MontyComplete)) {
          if (signal?.aborted) throw signal.reason;
          if (snapshot instanceof NameLookupSnapshot) {
            const name = snapshot.variableName;
            snapshot = Object.hasOwn(script.functions, name)
              ? await snapshot.resume(name)
              : await snapshot.resume();
          } else if (snapshot instanceof FunctionSnapshot) {
            const call = snapshot;
            if (call.isOsFunction) {
              snapshot = await call.resumeNotHandled();
              continue;
            }
            const fn = Object.hasOwn(script.functions, call.functionName)
              ? script.functions[call.functionName]
              : undefined;
            if (!fn) {
              snapshot = await call.resumeNotFound();
              continue;
            }
            const args = call.args.map(toJson);
            const kwargs = toJson(call.kwargs) as Record<string, unknown>;
            start(call.callId, async () => fn(args, kwargs));
            snapshot = await call.resumeFuture();
          } else {
            const waits = snapshot;
            // What each call it waits on came to: settled, still running, or waiting for a person.
            const ready: number[] = [];
            const open: number[] = [];
            const paused: { future: number; detail: unknown }[] = [];
            for (const id of waits.pendingCallIds) {
              const one = settled.get(id);
              if (!one) open.push(id);
              else if ("fatal" in one) throw one.fatal;
              else if ("pause" in one) paused.push({ future: id, detail: one.pause });
              else ready.push(id);
            }
            if (ready.length === 0 && open.length > 0) {
              await Promise.race(open.map(async (id) => started.get(id)));
              continue;
            }
            if (ready.length === 0) {
              // Every call it waits on waits for a person: it pauses where it stands.
              const dump = await waits.dump();
              if (dump.length <= pooled.pauseBytes) {
                return { ok: false, paused: { snapshot: dump, calls: paused }, printed };
              }
              const error = new PythonError(
                "RuntimeError",
                `The script holds too much to pause for an approval, over ${Math.round(pooled.pauseBytes / 1024 / 1024)} MB. Hold less before these calls, or make them directly.`,
              );
              for (const one of paused) {
                await script.tooLarge?.(one.detail, error);
                settled.set(one.future, { error });
              }
              continue;
            }
            snapshot = await waits.resume(
              ready.map((id) => {
                delivered.add(id);
                const one = settled.get(id)!;
                return "error" in one
                  ? { callId: id, error: one.error }
                  : { callId: id, value: (one as { value: unknown }).value };
              }),
            );
          }
        }
        await drain();
        return { ok: true, value: toJson(snapshot.output), printed };
      } catch (err) {
        if (signal?.aborted) return { ...stopped, printed };
        if (err instanceof MontyCrashedError && err.timedOut) {
          return { ok: false, error: "The script ran out of time.", printed };
        }
        if (
          err instanceof MontyRuntimeError ||
          err instanceof MontySyntaxError ||
          err instanceof MontyCrashedError
        ) {
          await drain();
          // Where the script used a call it never awaited, it is told how.
          const { typeName, message } = err.exception;
          const unawaited = typeName === "TypeError" && message.includes("'coroutine'");
          return {
            ok: false,
            error: `${messageOf(err)}${unawaited ? `\n\n${UNAWAITED}` : ""}`,
            printed,
          };
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", kill);
        await session.close().catch(() => {});
      }
    },

    // Closes the pool, its workers with it; one opens again when next used.
    async close() {
      const open = pool;
      pool = null;
      await (await open?.catch(() => null))?.close();
    },
  };
}
