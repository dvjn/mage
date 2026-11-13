// What the contract tests stand on: a thread with its people, an agent on a model the test
// drives, and tools made for the tests, reached only the ways the web client and the model reach
// the server: over HTTP, over the live streams, and through what the model is sent. Everything
// here is asked for and awaited, so the tests read the same however the server does its work.

import { createHmac } from "node:crypto";

import { expect } from "vite-plus/test";
import * as z from "zod";

import type { LiveReporter } from "@/server/agent/live.ts";
import type { ToolSpec } from "@/server/agent/tools.ts";
import type { BackgroundItem } from "@/shared/calls.ts";
import { STREAMS } from "@/shared/streams.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { ThreadListItem } from "@/shared/threads/list.ts";
import type { ShownRow, WaitingRow } from "@/shared/threads/rows.ts";
import type { TriggerHistory } from "@/shared/triggers.ts";

import { agentThread } from "./agent-thread.ts";
import type { Call } from "./scripted-model.ts";
import { openStream } from "./sse.ts";

export type Person = { cookie: string; userId: string; orgId: string };

const MINUTE = 60_000;

// Tools for the tests: one that runs until the test finishes it, by the label of its call, and
// one that needs a person's approval and then answers at once.
function probe() {
  const open = new Map<string, (output: { ok: true; value: unknown }) => void>();
  const aborted: string[] = [];
  const printing = new Map<string, LiveReporter>();
  const wait: ToolSpec<{ label: string }> = {
    name: "probe.wait",
    title: "Wait",
    description: "Waits.",
    input: z.object({ label: z.string() }),
    risk: () => "normal",
    run({ label }, ctx) {
      return new Promise((resolve) => {
        open.set(label, resolve);
        if (ctx.live) printing.set(label, ctx.live);
        ctx.signal?.addEventListener("abort", () => {
          aborted.push(label);
          resolve({ ok: false, error: "aborted" });
        });
      });
    },
  };
  const guarded: ToolSpec<{ label: string }> = {
    name: "probe.guarded",
    title: "Guarded",
    description: "Needs approval.",
    input: z.object({ label: z.string() }),
    risk: () => "ask",
    run: ({ label }) => Promise.resolve({ ok: true, value: { did: label } }),
  };
  const slowGuarded: ToolSpec<{ label: string }> = {
    ...wait,
    name: "probe.guarded_wait",
    title: "Guarded wait",
    description: "Needs approval, then waits.",
    risk: () => "ask",
  };
  return {
    toolset: {
      id: "probe",
      title: "Probe",
      source: "builtin" as const,
      tools: [wait, guarded, slowGuarded],
    },
    aborted,
    // Whether the call with the label has started running.
    running: (label: string) => open.has(label),
    // Has the running call with the label print the text, as a tool does while it works.
    async print(label: string, text: string) {
      await Promise.resolve(printing.get(label)!.output(text));
    },
    finish(label: string, value: unknown) {
      open.get(label)?.({ ok: true, value });
    },
  };
}

// Waits until what is read holds, reading it again every few milliseconds.
export async function eventually<T>(read: () => T | Promise<T>, holds: (value: T) => boolean) {
  for (let tries = 0; ; tries += 1) {
    const value = await read();
    if (holds(value)) return value;
    if (tries > 1500) throw new Error(`never held; last read ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export async function world(options: Parameters<typeof agentThread>[0] = {}) {
  const tool = probe();
  const base = await agentThread(options, { toolsets: [tool.toolset] });
  const { model, api, worker } = base;
  const ada: Person = base.ada;
  const grace: Person = base.grace;
  const alan: Person = base.alan;
  base.start();

  const taken = new Set<Call>();
  let callCount = 0;

  async function json<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) {
      throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  // The next call the model is asked in the thread, once it is made.
  async function callIn(threadId: string): Promise<Call> {
    return eventually(
      () =>
        model.calls.find(
          (candidate) => !taken.has(candidate) && candidate.request.sessionId === threadId,
        ),
      (call) => {
        if (call) taken.add(call);
        return !!call;
      },
    ) as Promise<Call>;
  }

  const thread = base.thread.id;
  // The worker now running, which a crash replaces.
  let current = worker;

  const it = {
    ada,
    grace,
    alan,
    spaceId: base.space.id,
    threadId: thread,
    api,
    json,

    // Signs someone else up, outside the thread's space.
    async signUp(name: string, email: string): Promise<Person> {
      return base.signUp(name, email);
    },

    // Takes the person's place in the thread's space away, as nothing in the app does yet for a
    // person's own space.
    async loses(who: Person) {
      await Promise.resolve(
        base.spaceStore.revoke(base.space.id, { kind: "user", id: who.userId }),
      );
    },

    // Posts a message, answering the status and what the server said.
    async post(who: Person, text: string, mode = "steer", threadId = thread) {
      const res = await api("POST", `/threads/${threadId}/messages`, who.cookie, { text, mode });
      return { status: res.status, body: (await res.json()) as { id?: string; error?: string } };
    },

    // Acts on the thread or one of its parts, answering the status.
    async act(who: Person, method: string, path: string, body?: object, threadId = thread) {
      const res = await api(method, `/threads/${threadId}${path}`, who.cookie, body);
      return res.status;
    },

    // The thread as the reader's page reads it.
    async detail(who: Person = ada, threadId = thread) {
      return json<ThreadDetail>(await api("GET", `/threads/${threadId}`, who.cookie));
    },

    // The thread's rows and what waits for its agent, each in a few words.
    async shown(who: Person = ada, threadId = thread) {
      const detail = await json<ThreadDetail>(await api("GET", `/threads/${threadId}`, who.cookie));
      return {
        rows: detail.rows.map(rowWords),
        waiting: detail.waiting.map(waitingWords),
        run: detail.run ? (detail.run.waiting ?? "running") : null,
      };
    },

    // The thread's activity list as the reader's tray reads it.
    async activity(who: Person = ada, threadId = thread) {
      const { items } = await json<{ items: BackgroundItem[] }>(
        await api("GET", `/threads/${threadId}/background`, who.cookie),
      );
      return items;
    },

    // The thread as its space's list shows it to the reader.
    async listed(who: Person = ada, threadId = thread) {
      const list = await json<ThreadListItem[]>(
        await api("GET", `/spaces/${base.space.id}/threads`, who.cookie),
      );
      const found = list.find((item) => item.id === threadId);
      if (!found) throw new Error("the thread is not listed");
      return found;
    },

    // The thread's next call to the model, asking for the tool calls in one step. Answers the call
    // and the ids of the tool calls it made.
    async asks(threadId: string, ...asked: [string, unknown][]) {
      const call = await callIn(threadId);
      const ids: string[] = [];
      call.startStep();
      call.delta("On it.");
      for (const [toolId, input] of asked) {
        callCount += 1;
        ids.push(`call-${callCount}`);
        call.toolCall(`call-${callCount}`, toolId, input);
      }
      call.endStep();
      call.end();
      return { call, ids };
    },

    // The thread's next call to the model, answered with the text.
    async answers(threadId: string, text = "Done.") {
      const call = await callIn(threadId);
      call.reply(text);
      return call;
    },

    // The thread's next call to the model, left open for the test to drive.
    next: callIn,

    // Brings the call to a step boundary, where the run takes in what steers it, answering what
    // that adds for the model to read.
    async boundary(call: Call) {
      return (await Promise.resolve(call.boundary())).map(
        (message) => `${message.role}: ${"text" in message ? message.text : ""}`,
      );
    },

    // How many calls the model has been made in the thread.
    modelCalls: (threadId = thread) =>
      model.calls.filter((call) => call.request.sessionId === threadId).length,

    // Waits until no run is under way anywhere.
    async settled() {
      await current.idle();
    },

    tool,

    // Moves the clock on and fires what came due, answering how many fired.
    async later(ms: number) {
      base.clock.now = new Date(base.clock.now.getTime() + ms);
      return Promise.resolve(base.triggers.tick());
    },

    // Posts to a webhook's address as an outside service would, signed when a secret is given.
    async hook(
      url: string,
      body: string,
      options: { secret?: string; headers?: Record<string, string> } = {},
    ) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...options.headers,
      };
      if (options.secret) {
        const digest = createHmac("sha256", options.secret).update(body).digest("hex");
        headers["X-Hub-Signature-256"] = `sha256=${digest}`;
      }
      const res = await base.app.request(new URL(url).pathname, {
        method: "POST",
        headers,
        body,
      });
      return res.status;
    },

    // Opens the thread's live stream for the reader, from after the event with the seq. Answers
    // a way to read what it sends, one event at a time: its name, its id where it has one and its
    // data; and a way to close it.
    async stream(who: Person = ada, after?: number) {
      const stream = await openStream(base.app, who.cookie, thread, { after });
      // Every event is one the stream is said to send, shaped as it is said to be.
      const read = (frame: { event?: string; id?: string; data?: string }) => {
        const event = frame.event as keyof typeof STREAMS.thread.events;
        const schema = STREAMS.thread.events[event];
        if (!schema) throw new Error(`the thread stream sent an unknown event: ${frame.event}`);
        return {
          event,
          id: frame.id === undefined ? null : Number(frame.id),
          data: schema.parse(JSON.parse(frame.data!)) as Record<string, any>,
        };
      };
      return {
        status: stream.res.status,
        async next() {
          return read(await stream.nextItem());
        },
        // The next event of the name, passing over others.
        async nextOf(event: keyof typeof STREAMS.thread.events) {
          for (;;) {
            const item = read(await stream.nextItem());
            if (item.event === event) return item;
          }
        },
        async close() {
          await stream.close();
        },
      };
    },

    // The thread of the subagent the agent named so, as the reader's list shows it.
    async subagentNamed(name: string, who: Person = ada) {
      const list = await json<ThreadListItem[]>(
        await api("GET", `/spaces/${base.space.id}/threads`, who.cookie),
      );
      const found = list
        .flatMap((item) => item.subagents ?? [])
        .find((subagent) => subagent.name === name);
      if (!found) throw new Error(`no subagent ${name}`);
      return found.threadId;
    },

    // Has the server find the jobs a stopped server left running, as it does once their holder
    // has been gone long enough.
    async crashJobs() {
      await Promise.resolve(base.calls.recover(new Date(Date.now() + 10 * MINUTE)));
    },

    // Stops the server's worker as a crash would, mid-run, and brings up another that recovers
    // what it left.
    async crash() {
      await current.stop();
      current = base.makeWorker();
      await Promise.resolve(current.recover());
      await Promise.resolve(base.start(current));
    },
  };

  // Decides a call waiting for approval, answering the status.
  async function decide(
    who: Person,
    callId: string,
    allow: boolean,
    scope = "once",
    threadId = thread,
  ) {
    const res = await api("POST", `/threads/${threadId}/tools/${callId}/decision`, who.cookie, {
      allow,
      scope,
    });
    return res.status;
  }

  // Has the agent set something up with the tool, which Ada approves, answering what the tool
  // gave back.
  async function setUp<T>(toolId: string, input: object, approved = false): Promise<T> {
    await it.post(ada, "Set it up");
    const { ids } = await it.asks(thread, [toolId, input]);
    if (approved) {
      await eventually(
        () => it.detail(),
        (detail) => detail.run?.waiting === "decision",
      );
      expect(await decide(ada, ids[0]!, true)).toBe(200);
    }
    const told = await it.answers(thread, "Set up.");
    await current.idle();
    const result = told.request.messages
      .flatMap((message) => (message.role === "tool" ? message.results : []))
      .at(-1)?.output as { ok: true; value: T };
    return result.value;
  }

  return {
    ...it,
    decide,
    // A webhook the agent made, with the address it is posted to.
    webhook: (name: string, note: string) =>
      setUp<{ id: string; url: string }>("triggers.add_webhook", { name, note }, true),
    // A wake-up timer the agent set, to go off in so many seconds.
    wakeUp: (seconds: number, note: string) =>
      setUp<{ id: string }>("triggers.wake_at", { in_seconds: seconds, note }),
    // What the schedule or webhook has fired, newest first, as its history lists it.
    async history(who: Person, id: string) {
      return json<TriggerHistory>(
        await api("GET", `/threads/${thread}/triggers/${id}/history`, who.cookie),
      );
    },
    // A schedule the agent made, by cron expression.
    schedule: (name: string, cron: string, prompt: string) =>
      setUp<{ id: string }>("triggers.schedule", { name, cron, prompt }),
  };
}

export type World = Awaited<ReturnType<typeof world>>;

// A row in a few words: whose it is and what it says or where it stands.
export function rowWords(row: ShownRow): string {
  switch (row.kind) {
    case "human":
      return `${row.author.name}: ${row.text}`;
    case "agent":
      return `agent (${row.status}): ${row.text}`;
    case "tool":
      return `${row.toolId} ${row.state}${row.waits && row.state === "pending" ? " waits" : ""}${row.background ? ` [${row.background.status}]` : ""}`;
    case "relay":
      return `${row.type}: ${row.text.split("\n")[0]}`;
    case "stop":
      return `stopped by ${row.by}`;
    case "failure":
      return `failed${row.failure ? ` (${row.failure})` : ""}`;
    default:
      return row.kind;
  }
}

function waitingWords(row: WaitingRow): string {
  const can = row.waiting?.can.join("+") || "nothing";
  if (row.kind === "human") {
    return `${row.author.name} (${row.waiting?.mode}): ${row.text} [${can}]`;
  }
  return `${row.type}: ${row.text.split("\n")[0]} [${can}]`;
}

export { MINUTE, expect };
