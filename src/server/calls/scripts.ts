// Scripts: Python the agent runs to chain tool calls and work on their results, so that only what
// the script returns and prints reaches the model. A script calls each tool as a function by the
// tool's name with keywords as its input, or by name through one function. Each call is an
// ordinary call of the script's run, recorded in the thread with the script as the call that made
// it, judged as a direct one would be and run under the run's lease. One that waits for a person
// pauses the script: where it stood is kept with the call waiting, and the run waits as for any
// approval.
// Once decided, the script starts again where it stood, on whichever instance takes the run up,
// and the call runs, or raises PermissionError where it was denied. The tools that ask people
// questions and the tool search fail in a script. What the script's calls are judged with is read
// once, as the script starts or goes on, but for the tools' rules, read again for each call inside
// the write that records it, so a tool turned off or set to ask meanwhile holds from the next call.
// A learned skill's script runs by its file, recorded with the code it read then.

import { context, trace } from "@opentelemetry/api";
import { ulid } from "ulid";
import * as z from "zod";

import type { Logger } from "@/server/kernel/logger.ts";
import type { Word } from "@/server/queue/queue.ts";
import type { Space, SpaceStore } from "@/server/spaces/service.ts";
import { LeaseLost } from "@/server/sync/lease.ts";
import type { NewEvent, Thread, ThreadStore } from "@/server/threads/types.ts";
import type { Decision } from "@/server/tools/authority.ts";
import {
  type AnyToolSpec,
  type CallView,
  definitionOf,
  type People,
  type SpaceTools,
  type ToolContext,
  type ToolOutput,
  type Tools,
  type Toolset,
  type ToolSpec,
  type Vouch,
} from "@/server/tools/registry.ts";
import {
  closest,
  functionNames,
  listedSignature,
  parametersOf,
  signatureOf,
  signaturesText,
  takesNull,
  type ToolSchemas,
} from "@/server/tools/signatures.ts";
import { learnedScript, RUN_SCRIPT } from "@/server/skills/scripts.ts";
import { CHECK_JOB, START_JOB } from "@/shared/jobs.ts";
import { valueForAgent } from "@/shared/mcp.ts";
import type { EventDataMap, ToolRisk } from "@/shared/threads/events.ts";
import { textOf, type ToolText, wireToolName } from "@/shared/tools.ts";

import { CallPaused, ranData, spanEnded, toolSpan } from "./lifecycle.ts";
import {
  createPython,
  PythonError,
  PythonPause,
  SCRIPT_CALLS,
  SCRIPT_SLEEP_SECS,
} from "./python.ts";
import { callableIn, ToolRefusal, toolNamed } from "./resolve.ts";
import type { CallRow, NewCallRow } from "./store.ts";
import type { CallRecord } from "./views.ts";

export const SCRIPTS_TOOLSET = "scripts";

// The function a script calls any tool with by its name, and those that list and describe them.
const CALL_TOOL = "call_tool";
const LIST_TOOLS = "list_tools";
const DESCRIBE_TOOL = "describe_tool";

// The most characters of tools' signatures the model is given; the rest it is given by name.
export const SIGNATURE_CHARS = 8000;

export const SCRIPTS_GUIDANCE: ToolText = (named) =>
  [
    `Call a tool directly to look at a short result or to change something. Use ${named(RUN_SCRIPT)} for exact calculations and deterministic checks, to chain several tool calls in one Python script rather than one by one, and to filter, count, parse, compare or combine results, as when you need only a few fields or a count from a large result. Only what the script returns and prints comes back to you.`,
    `- In a script each tool is an awaitable function by the name you call it, taking its input as keyword arguments: \`r = await name(key=value)\` gives the tool's result. Up to ${SCRIPT_CALLS} calls a script. Run independent calls at once with \`await asyncio.gather(...)\`, catching each call's errors inside its own task, as gather does not return them. A call that needs approval pauses the script until someone decides, then runs, or raises PermissionError where denied. Other failures raise NameError, ValueError, TypeError or RuntimeError, and calls already made are not undone.`,
    `- Every tool here, MCP tools among them, is callable from a script by name, without searching for it or turning it on first; search only to find a tool you don't know.`,
    `- \`await ${LIST_TOOLS}(query=None)\` gives the names of the tools a script may call, MCP tools among them, those matching the query when given; \`await ${DESCRIBE_TOOL}(name)\` gives one's signature.`,
    "- Write the script against named inputs and pass their values in `inputs`, so the same script runs again with others.",
    '- A learned skill\'s script runs by its file, `file="<skill>/<path>"` in place of `code`, with its values in `inputs`.',
    `- A long script can run in the background with ${named(START_JOB)}; what it prints is what ${named(CHECK_JOB)} shows of it as it runs. To poll, sleep between checks with \`await asyncio.sleep(seconds)\`, up to ${SCRIPT_SLEEP_SECS / 60} minutes a script.`,
    "- The last expression is the result: return the smallest thing that answers, not whole results to read. print() for notes. Dates and times come back as ISO 8601 text.",
    "- The sandbox runs a subset of Python, with json, re, math, datetime, collections, itertools and decimal, and no network or files. Tools that ask people questions and the tool search cannot be called from it.",
  ].join("\n");

// Whether a script may call the tool.
function scriptMayCall(spec: AnyToolSpec) {
  return !spec.makesCalls && spec.waitsFor !== "answer" && spec.deferral !== "search";
}

const schemasRead = new WeakMap<AnyToolSpec, ToolSchemas>();

// What the tool takes and gives back, as JSON Schemas, read once for each tool.
function schemasOf(spec: AnyToolSpec): ToolSchemas {
  let schemas = schemasRead.get(spec);
  if (!schemas) {
    const { inputSchema, outputSchema } = definitionOf(spec);
    schemas = { inputSchema, ...(outputSchema && { outputSchema }) };
    schemasRead.set(spec, schemas);
  }
  return schemas;
}

// A tool as a script's function: by its name for the model, as Python names it.
interface ScriptFunction {
  name: string;
  // Its name for the model.
  wire: string;
  spec: AnyToolSpec;
  schemas: ToolSchemas;
}

// The tools a script may call as its functions, in the order offered, by their Python names.
function scriptFunctions(offered: readonly AnyToolSpec[], named: (toolId: string) => string) {
  const specs = offered.filter(scriptMayCall);
  const wires = specs.map((spec) => wireToolName(named(spec.name)));
  const names = functionNames(wires);
  return new Map(
    specs.map((spec, index) => {
      const wire = wires[index]!;
      const name = names.get(wire)!;
      return [name, { name, wire, spec, schemas: schemasOf(spec) }];
    }),
  );
}

// The guidance of the scripts' toolset with the signature of each tool a script may call that the
// prompt shows: not those left out of the request until turned on, so turning one on leaves the
// prompt as it was.
export function withSignatures<T extends { text: ToolText }>(
  toolsets: readonly T[],
  offered: readonly AnyToolSpec[],
  shown: (spec: AnyToolSpec) => boolean,
  chars = SIGNATURE_CHARS,
): T[] {
  return toolsets.map((toolset) =>
    toolset.text === SCRIPTS_GUIDANCE
      ? {
          ...toolset,
          text: (named) => {
            const functions = [...scriptFunctions(offered, named).values()];
            const lines = functions
              .filter((fn) => shown(fn.spec))
              .map((fn) => ({
                name: fn.name,
                signature: listedSignature(fn.name, fn.schemas),
              }));
            return [
              textOf(SCRIPTS_GUIDANCE, named),
              ...(lines.length > 0
                ? ["Tools as a script calls them:", signaturesText(lines, chars)]
                : []),
            ].join("\n");
          },
        }
      : toolset,
  );
}

// Python's reserved words, which cannot name an input.
const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);

// Whether the name may name a variable of the script.
function pythonName(name: string) {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !KEYWORDS.has(name) &&
    ![CALL_TOOL, LIST_TOOLS, DESCRIBE_TOOL].includes(name)
  );
}

// The steps a script's calls take as every call does, from the calls that own them.
export interface ScriptSteps {
  words(threadId: string, branchId: string): Promise<Word[]>;
  vouches(threadId: string, branchId: string): Promise<Vouch[]>;
  judge(ask: {
    words: readonly Word[];
    vouches: readonly Vouch[];
    thread: Thread;
    space: Space;
    spec: AnyToolSpec;
    input: unknown;
    model: string | null;
    now?: SpaceTools;
    people?: People;
  }): Promise<Decision>;
  // Makes the call's row, inside the write that appends its request.
  requested(row: NewCallRow): Promise<CallRow>;
  // Records the call's result and ends its row as it says.
  ran(
    append: (event: NewEvent) => Promise<unknown>,
    threadId: string,
    data: EventDataMap["tool.ran"],
  ): Promise<void>;
  // Pauses the running script where its sandbox stood; null when it no longer runs.
  pause(
    threadId: string,
    callId: string,
    kept: { snapshot: Buffer; printed: string; waiting: { future: number; callId: string }[] },
  ): Promise<CallRow | null>;
  // Where the script stood, taken once, how many calls it made, and for one that paused, the
  // calls it waited on with what authority reads of them, by the sandbox's id.
  resumeOf(
    threadId: string,
    callId: string,
  ): Promise<{
    pause: { snapshot: Buffer; printed: string } | null;
    made: number;
    waitedOn: Map<number, { row: CallRow; record: CallRecord }>;
  }>;
  // How an approved call runs while its approval holds; null once it lapsed.
  approvedNow(ask: {
    call: CallView & { decision: NonNullable<CallView["decision"]> };
    words: readonly Word[];
    thread: Thread;
    space: Space;
    spec: AnyToolSpec;
    input: unknown;
    model: string | null;
    now?: SpaceTools;
  }): Promise<{ runAs: string | null; approvedBy: string } | null>;
  // Lets a waiting call that came to need nobody stand ready, decided by nobody.
  allow(threadId: string, callId: string): Promise<unknown>;
  // Starts a call approved meanwhile; null when it no longer stands ready.
  start(threadId: string, callId: string): Promise<CallRow | null>;
  // Ends a call that will not run, and why.
  drop(
    append: (event: NewEvent) => Promise<unknown>,
    call: { threadId: string; id: string; runId: string; toolId: string },
    reason: "stale" | "cancelled",
  ): Promise<void>;
  // Cancels what the calls made, and what that made in turn.
  cancelBelow(
    append: (event: NewEvent) => Promise<unknown>,
    threadId: string,
    ids: readonly string[],
  ): Promise<void>;
}

export interface ScriptsOptions {
  threads: Pick<ThreadStore, "find">;
  spaceStore: Pick<SpaceStore, "find">;
  logger: Logger;
  tools: Pick<
    Tools,
    | "toolsIn"
    | "offered"
    | "modelNames"
    | "fromServers"
    | "turnedOn"
    | "namesNow"
    | "rulesIn"
    | "riskOf"
    | "approvalHolds"
    | "run"
  >;
  steps: ScriptSteps;
  now: () => Date;
}

// A call that waits for a person, as the script pauses at it.
interface Waiting {
  id: string;
  toolId: string;
  input: unknown;
  risk: ToolRisk;
}

const ACTOR = { kind: "agent" } as const;

function messageOf(err: unknown) {
  return err instanceof Error && err.message ? err.message : "The tool failed.";
}

export function createScripts(options: ScriptsOptions) {
  const { threads, spaceStore, logger, tools, steps, now } = options;
  const python = createPython();

  const run: ToolSpec<{ code?: string; file?: string; inputs?: Record<string, unknown> }> = {
    name: RUN_SCRIPT,
    title: "Run script",
    makesCalls: true,
    annotations: { readOnlyHint: false },
    description: `Run a Python script, for exact calculations, deterministic checks, and several tool calls chained in one go. It calls each tool as an awaitable function by its name with keyword arguments, \`await name(key=value)\`, several at once with asyncio.gather, each judged as if made directly, and gives back its last expression and what it printed. The keys of \`inputs\` become the script's variables.`,
    input: z
      .object({
        code: z
          .string()
          .min(1)
          .optional()
          .meta({ title: "Code", description: "Python", contentMediaType: "text/x-python" }),
        file: z.string().trim().min(1).optional().meta({
          title: "File",
          description: "A learned skill's script as skill/path, in place of code",
        }),
        // An object, not unknown: with no type in its schema the model sends it as a JSON string.
        inputs: z
          .record(z.string(), z.unknown())
          .superRefine((inputs, check) => {
            const bad = Object.keys(inputs).filter((name) => !pythonName(name));
            if (bad.length > 0) {
              check.addIssue({
                code: "custom",
                message: `Input names must be Python identifiers, not ${bad.join(", ")}.`,
              });
            }
          })
          .optional()
          .meta({ title: "Inputs", description: "Values the script reads by name" }),
      })
      .refine((given) => given.code !== undefined || given.file !== undefined, {
        message: "Give the code, or a file to run.",
      }),
    // Each call it makes is judged on its own.
    risk: () => "normal",
    // A file is recorded with its code as it reads now, so later edits leave the call as it ran.
    resolveInput(given, now) {
      if (given.file === undefined) return { input: given };
      if (given.code !== undefined) return { error: "Give the code or a file, not both." };
      const script = learnedScript(now, given.file);
      return "error" in script ? script : { input: { ...given, code: script.code } };
    },
    async run({ code, inputs }, ctx) {
      if (code === undefined) return { ok: false, error: "The script's file was not read." };
      const thread = await threads.find(ctx.threadId);
      const space = thread && (await spaceStore.find(thread.spaceId));
      if (!thread || !space) return { ok: false, error: "The thread is gone." };
      // A script that paused goes on from where it stood, the calls it waited on answered there.
      const resumed = await ctx.write(async () => steps.resumeOf(thread.id, ctx.callId));
      const { waitedOn } = resumed;
      // One that made calls and has nowhere to go on from cannot start again from the top.
      if (!resumed.pause && resumed.made > 0) {
        await ctx.write(async (append) => steps.cancelBelow(append, thread.id, [ctx.callId]));
        return { ok: false, error: "The script could not go on: where it stood was lost." };
      }
      // Calls made so far, toward the cap, whichever instance made them.
      let made = resumed.made;
      // Records each call once the one made before it is recorded, so gathered calls keep their order.
      let recorded: Promise<unknown> = Promise.resolve();
      const recordInTurn: typeof ctx.write = async (work) => {
        const turn = recorded.then(async () => ctx.write(work));
        recorded = turn.catch(() => {});
        return turn;
      };
      const callable = await callableIn(tools, thread, space, ctx.names, true);
      const titles = await tools.namesNow(space, callable.now);
      const branchId = thread.currentBranchId;
      const words = await steps.words(thread.id, branchId);
      const vouches = await steps.vouches(thread.id, branchId);
      // Each person read once for the script's calls.
      const people: People = new Map();
      // The tools' rules as they stand now.
      const rulesNow = async () => ({
        ...callable.now,
        rules: await tools.rulesIn(space, callable.now.added.forOrgSettings),
      });

      const functions = scriptFunctions(callable.offered, callable.names.toModel);
      const functionOf = new Map([...functions.values()].map((fn) => [fn.spec.name, fn]));
      const taken = (inputs ? Object.keys(inputs) : []).filter((key) => functions.has(key));
      if (taken.length > 0) {
        return {
          ok: false,
          error: `Input names must not be those of tools' functions, as ${taken.join(", ")} are.`,
        };
      }
      // What the script is told of a name no tool has, with the signatures of those nearest it.
      const notFound = (name: string) => {
        const near = closest(name, [...functions.keys()]);
        const hint = near.length
          ? ` Did you mean:\n${near.map((one) => signatureOf(one, functions.get(one)!.schemas)).join("\n")}`
          : ` ${LIST_TOOLS}() gives their names.`;
        return `No tool is named ${name} here.${hint}`;
      };

      // Why the script may not call the tool by the name, as the exception it raises.
      const refusalOf = (name: string): { spec: AnyToolSpec } | { refusal: PythonError } => {
        try {
          const spec = toolNamed(callable, name);
          if (spec.makesCalls) throw new ToolRefusal("A script cannot run another.");
          if (spec.waitsFor === "answer" || spec.deferral === "search") {
            throw new ToolRefusal(`${ctx.named(spec.name)} cannot be called from a script.`);
          }
          return { spec };
        } catch (err) {
          if (!(err instanceof ToolRefusal)) throw err;
          if (err.reason === "missing") {
            return { refusal: new PythonError("NameError", notFound(name)) };
          }
          return { refusal: new PythonError("PermissionError", err.message) };
        }
      };

      // Runs the call that may run, and records what it gave back, answering it to the script.
      const execute = async (
        spec: AnyToolSpec,
        input: unknown,
        id: string,
        how: Pick<ToolContext, "runAs" | "approvedBy"> & { standingOn?: string },
        // The run that asked for it, as its request names it.
        runId = ctx.runId,
      ) => {
        const started = now().getTime();
        const span = toolSpan(spec.name, id, input);
        let output: ToolOutput;
        try {
          output = await context.with(trace.setSpan(context.active(), span), () =>
            tools.run(spec, input, {
              threadId: thread.id,
              spaceId: space.id,
              orgId: space.orgId,
              runId,
              callId: id,
              actor: ACTOR,
              model: ctx.model,
              runAs: how.runAs,
              ...(how.approvedBy && { approvedBy: how.approvedBy }),
              influence: ctx.influence,
              named: ctx.named,
              ...(ctx.signal && { signal: ctx.signal }),
              ...(ctx.threadRequest && { threadRequest: ctx.threadRequest }),
              write: async (work) => ctx.write(work),
            }),
          );
        } catch (err) {
          if (err instanceof LeaseLost) {
            span.end();
            throw err;
          }
          logger.warn({ err, runId: ctx.runId, toolId: spec.name }, "tool failed");
          output = { ok: false, error: messageOf(err) };
        }
        spanEnded(span, output);
        const ms = Math.max(0, now().getTime() - started);
        const { standingOn } = how;
        await ctx.write(async (append) =>
          steps.ran(
            append,
            thread.id,
            ranData(runId, id, output, ms, { ...(standingOn && { standingOn }) }),
          ),
        );
        if (!output.ok) throw new PythonError("RuntimeError", output.error);
        // As the model would read it, in JSON.
        return JSON.parse(JSON.stringify(valueForAgent(output.value) ?? null)) as unknown;
      };

      // Records the call the script made and runs it when it may run, answering what it gave back;
      // pauses the script at one that waits for a person.
      const callTool = async (name: string, given: unknown) => {
        if (made >= SCRIPT_CALLS) {
          throw new PythonError("RuntimeError", `A script makes at most ${SCRIPT_CALLS} calls.`);
        }
        made += 1;
        const id = ulid();
        const found = refusalOf(name);
        const spec = "spec" in found ? found.spec : undefined;
        let refusal = "refusal" in found ? found.refusal : undefined;
        const fn = spec && functionOf.get(spec.name);
        // Keywords the schema refuses, as JSON Schema has it: only where it allows no others.
        const params = fn && parametersOf(fn.schemas.inputSchema);
        const unexpected =
          params?.closed && typeof given === "object" && given !== null
            ? Object.keys(given).find((key) => !Object.hasOwn(params.properties, key))
            : undefined;
        const parsed =
          refusal || unexpected !== undefined ? undefined : spec?.input.safeParse(given);
        if (fn && !refusal && unexpected !== undefined) {
          const [near] = closest(unexpected, Object.keys(params!.properties), 1);
          refusal = new PythonError(
            "ValueError",
            `${fn.name} takes no argument ${unexpected}.${near ? ` Did you mean ${near}?` : ""}\n${signatureOf(fn.name, fn.schemas)}`,
          );
        }
        if (parsed && !parsed.success) {
          refusal = new PythonError(
            "ValueError",
            `The input is not valid: ${z.prettifyError(parsed.error)}${fn ? `\n${signatureOf(fn.name, fn.schemas)}` : ""}`,
          );
        }
        const input: unknown = parsed?.success ? parsed.data : given;
        const toolId = spec?.name ?? callable.names.fromModel(name) ?? name;
        const judged = await recordInTurn(
          async (append): Promise<{ waiting: Waiting } | { decision: Decision } | null> => {
            let risk: ToolRisk = "normal";
            let decision: Decision | null = null;
            if (spec && !refusal) {
              const now = await rulesNow();
              if (now.rules(spec.name).off) {
                refusal = new PythonError(
                  "PermissionError",
                  `${ctx.named(spec.name)} is off here.`,
                );
              } else {
                risk = await tools.riskOf(space, spec, input, ctx.model, now);
                decision = await steps.judge({
                  words,
                  vouches,
                  thread,
                  space,
                  spec,
                  input,
                  model: ctx.model,
                  now,
                  people,
                });
                // Recorded as the script pauses, in the write that keeps where it stood.
                if (decision.kind === "wait") return { waiting: { id, toolId, input, risk } };
              }
            }
            const names = spec && titles(spec.name);
            const requested = await append({
              type: "tool.requested",
              actor: ACTOR,
              data: {
                runId: ctx.runId,
                callId: id,
                messageId: "",
                within: ctx.callId,
                toolId,
                input,
                risk,
                waits: false,
                ...(names && { title: names.title }),
                ...(names?.toolset && { toolset: names.toolset }),
              },
            });
            await steps.requested({
              threadId: thread.id,
              id,
              branchId,
              seq: requested.seq,
              runId: ctx.runId,
              parentId: ctx.callId,
              toolId,
              risk,
              status: refusal ? "failed" : "running",
              waitsFor: null,
              background: false,
              model: ctx.model,
            });
            if (refusal) {
              await append({
                type: "tool.ran",
                actor: ACTOR,
                data: ranData(ctx.runId, id, { ok: false, error: refusal.message }, 0),
              });
              return null;
            }
            return { decision: decision! };
          },
        );
        if (judged && "waiting" in judged) throw new PythonPause(judged.waiting);
        if (!judged || judged.decision.kind === "wait" || !spec) throw refusal!;
        const { decision } = judged;
        return execute(spec, input, id, {
          runAs: decision.runAs ?? null,
          ...(decision.kind === "standing" && decision.callId && { standingOn: decision.callId }),
        });
      };

      // A call the script paused at, answered as it goes on: run once approved while the approval
      // holds, or once it came to need nobody, else raised as refused.
      const decided = async ({ row, record }: { row: CallRow; record: CallRecord }) => {
        const spec = callable.offered.find((one) => one.name === row.toolId);
        const named = ctx.named(row.toolId);
        if (row.status === "denied" || row.status === "skipped") {
          throw new PythonError("PermissionError", `${named} was denied.`);
        }
        const parsed = spec?.input.safeParse(record.input);
        const { decision: given } = record;
        // Approved, while the approval holds; one that came to need nobody, as judged now, let
        // run in the write that starts it.
        const go =
          (row.status === "ready" || row.status === "waiting") &&
          (await ctx.write(async (append) => {
            const now = await rulesNow();
            let how: Pick<ToolContext, "runAs" | "approvedBy"> & { standingOn?: string } = {
              runAs: null,
            };
            let holds = false;
            if (spec && parsed?.success && !now.rules(spec.name).off) {
              if (given?.allow) {
                const approved = await steps.approvedNow({
                  call: { ...record, decision: given },
                  words,
                  thread,
                  space,
                  spec,
                  input: parsed.data,
                  model: ctx.model,
                  now,
                });
                holds = !!approved;
                if (approved) how = approved;
              } else {
                const decision = await steps.judge({
                  words,
                  vouches,
                  thread,
                  space,
                  spec,
                  input: parsed.data,
                  model: ctx.model,
                  now,
                  people,
                });
                holds = decision.kind !== "wait";
                if (decision.kind !== "wait") {
                  how = {
                    runAs: decision.runAs ?? null,
                    ...(decision.kind === "standing" &&
                      decision.callId && { standingOn: decision.callId }),
                  };
                }
              }
            }
            if (!holds || !spec || !parsed?.success) {
              await steps.drop(append, row, "stale");
              return null;
            }
            if (row.status === "waiting") await steps.allow(thread.id, row.id);
            return (await steps.start(thread.id, row.id)) && { how, spec, input: parsed.data };
          }));
        if (!go) {
          throw new PythonError(
            "PermissionError",
            `${named} did not run: its approval no longer held.`,
          );
        }
        return execute(go.spec, go.input, row.id, go.how, row.runId);
      };

      // Records a call that would wait for a person: waiting, as the script pauses at it, or failed.
      const record = async (
        append: (event: NewEvent, title?: string) => Promise<{ seq: number }>,
        waiting: Waiting,
        waits: boolean,
      ) => {
        const names = titles(waiting.toolId);
        const requested = await append({
          type: "tool.requested",
          actor: ACTOR,
          data: {
            runId: ctx.runId,
            callId: waiting.id,
            messageId: "",
            within: ctx.callId,
            toolId: waiting.toolId,
            input: waiting.input,
            risk: waiting.risk,
            waits,
            ...(names && { title: names.title }),
            ...(names?.toolset && { toolset: names.toolset }),
          },
        });
        await steps.requested({
          threadId: thread.id,
          id: waiting.id,
          branchId,
          seq: requested.seq,
          runId: ctx.runId,
          parentId: ctx.callId,
          toolId: waiting.toolId,
          risk: waiting.risk,
          status: waits ? "waiting" : "failed",
          waitsFor: waits ? "decision" : null,
          background: false,
          model: ctx.model,
        });
      };

      const misuse = () =>
        new PythonError("TypeError", `${CALL_TOOL}(name, input) takes a tool's name and a dict.`);
      // Calls the tool with its keyword arguments as call_tool would with them as a dict; an
      // optional one given None, where its schema takes no null, is left out, as if not given.
      const typed =
        (fn: ScriptFunction) => async (args: unknown[], kwargs: Record<string, unknown>) => {
          if (args.length > 0) {
            throw new PythonError(
              "TypeError",
              `${fn.name} takes its input as keyword arguments: ${signatureOf(fn.name, fn.schemas)}`,
            );
          }
          const { properties, required } = parametersOf(fn.schemas.inputSchema);
          const input = Object.fromEntries(
            Object.entries(kwargs).filter(
              ([key, value]) => value !== null || required.has(key) || takesNull(properties[key]),
            ),
          );
          return callTool(fn.wire, input);
        };
      const byWire = new Map([...functions.values()].map((fn) => [fn.wire, fn]));
      // The function by its name, or by any name the tool goes by.
      const functionNamed = (name: string) =>
        functions.get(name) ??
        byWire.get(name) ??
        byWire.get(wireToolName(callable.names.toModel(callable.names.fromModel(name) ?? name)));
      const outcome = await python.run({
        code,
        ...(inputs && { inputs }),
        ...(resumed.pause && {
          resume: {
            ...resumed.pause,
            answer: async (future: number) => {
              const one = waitedOn.get(future);
              waitedOn.delete(future);
              if (!one) throw new PythonError("PermissionError", "The call did not run.");
              return decided(one);
            },
          },
        }),
        // Refused a pause as too large, the call fails where the script made it.
        tooLarge: async (detail, error) => {
          const waiting = detail as Waiting;
          await ctx.write(async (append) => {
            await record(append, waiting, false);
            await append({
              type: "tool.ran",
              actor: ACTOR,
              data: ranData(ctx.runId, waiting.id, { ok: false, error: error.message }, 0),
            });
          });
        },
        functions: {
          ...Object.fromEntries([...functions.values()].map((fn) => [fn.name, typed(fn)])),
          [CALL_TOOL]: async ([name, input], kwargs) => {
            const dict = typeof input === "object" && input !== null && !Array.isArray(input);
            if (typeof name !== "string" || Object.keys(kwargs).length > 0) throw misuse();
            if (input !== undefined && !dict) throw misuse();
            return callTool(name, input ?? {});
          },
          // Neither makes a call of a tool.
          [LIST_TOOLS]: async ([given], kwargs) => {
            const query = given ?? kwargs.query ?? null;
            if (query !== null && typeof query !== "string") {
              throw new PythonError("TypeError", `${LIST_TOOLS}(query=None) takes text or None.`);
            }
            const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
            return Promise.resolve(
              [...functions.values()]
                .filter((fn) => {
                  const text = `${fn.name} ${textOf(fn.spec.description, ctx.named)}`.toLowerCase();
                  return words.every((word) => text.includes(word));
                })
                .map((fn) => fn.name),
            );
          },
          [DESCRIBE_TOOL]: async ([given], kwargs) => {
            const name = given ?? kwargs.name;
            if (typeof name !== "string") {
              throw new PythonError("TypeError", `${DESCRIBE_TOOL}(name) takes a tool's name.`);
            }
            const fn = functionNamed(name);
            if (!fn) throw new PythonError("NameError", notFound(name));
            return Promise.resolve(signatureOf(fn.name, fn.schemas));
          },
        },
        // A name shaped as a tool's, `server__tool`, that names no function of the script is called
        // as call_tool calls it, to fail the same way; any other is Python's NameError.
        unknown: (name) =>
          name.includes("__") ? async (_args, kwargs) => callTool(name, kwargs) : undefined,
        ...(ctx.live && { print: (text: string) => ctx.live!.output(text) }),
        ...(ctx.signal && { signal: ctx.signal }),
      });
      // A call waited on that the script never came back to never runs; what a stopped script
      // made goes with it.
      const stopped = !!ctx.signal?.aborted;
      if (waitedOn.size > 0 || stopped) {
        await ctx.write(async (append) => {
          for (const { row } of waitedOn.values()) await steps.drop(append, row, "cancelled");
          if (stopped) await steps.cancelBelow(append, thread.id, [ctx.callId]);
        });
      }
      const { printed } = outcome;
      if ("paused" in outcome) {
        const { snapshot, calls } = outcome.paused;
        await ctx.write(async (append) => {
          const waiting = calls.map(({ future, detail }) => ({ future, call: detail as Waiting }));
          for (const { call } of waiting) await record(append, call, true);
          const kept = {
            snapshot,
            printed,
            waiting: waiting.map(({ future, call }) => ({ future, callId: call.id })),
          };
          if (!(await steps.pause(thread.id, ctx.callId, kept))) {
            throw new LeaseLost(`script ${ctx.callId}`);
          }
        });
        throw new CallPaused();
      }
      if (!outcome.ok) {
        return {
          ok: false,
          error: printed ? `${outcome.error}\n\nPrinted before it:\n${printed}` : outcome.error,
        };
      }
      return { ok: true, value: { result: outcome.value ?? null, ...(printed && { printed }) } };
    },
  };

  return {
    toolset(): Toolset {
      return {
        id: SCRIPTS_TOOLSET,
        title: "Scripts",
        source: "builtin",
        description: "Python that calls tools",
        guidance: SCRIPTS_GUIDANCE,
        tools: [run],
      };
    },

    // Closes the sandbox's workers.
    stop: async () => python.close(),
  };
}
