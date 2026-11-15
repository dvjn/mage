// What the contract tests stand on: a thread with its people, an agent on a model the test
// drives, and tools made for the tests, reached only the ways the web client and the model reach
// the server: over HTTP, over the live streams, and through what the model is sent. Everything
// here is asked for and awaited, so the tests read the same however the server does its work.

import { createHmac } from "node:crypto";

import { expect, onTestFinished } from "vite-plus/test";
import * as z from "zod";

import type { LiveReporter } from "@/server/calls/live.ts";
import * as schema from "@/server/schema.ts";
import type { ToolSpec } from "@/server/tools/registry.ts";
import type { ActivityItem } from "@/shared/jobs.ts";
import { STREAMS } from "@/shared/streams.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";
import type { ThreadListItem } from "@/shared/threads/list.ts";
import type { ShownRow, WaitingRow } from "@/shared/threads/rows.ts";
import type { FiredHistory } from "@/shared/schedules-and-webhooks.ts";

import { agentThread } from "./agent-thread.ts";
import { expireLeases } from "./database.ts";
import type { Call } from "./scripted-model.ts";
import { openFeed, openStream } from "./sse.ts";
import { setup } from "./workspace.ts";

export type Person = { cookie: string; userId: string; orgId: string };

const MINUTE = 60_000;

// Tools for the tests: one that runs until the test finishes it, by the label of its call, and
// one that needs a person's approval and then answers at once.
export function probe() {
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

export async function world(
  options: Parameters<typeof agentThread>[0] = {},
  harness: Omit<NonNullable<Parameters<typeof agentThread>[1]>, "toolsets"> = {},
) {
  const tool = probe();
  const base = await agentThread(options, { ...harness, toolsets: [tool.toolset] });
  const { model, api, worker } = base;
  const ada: Person = base.ada;
  const grace: Person = base.grace;
  const alan: Person = base.alan;
  await base.start();
  // Streams that beat seldom end with the test rather than at their next beat.
  if (harness.heartbeatMs) onTestFinished(() => base.shutdown.abort());

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

    // Signs someone up into the thread's org without a place in its space, and has Ada add them
    // to the thread as a guest, for good or for as long as said.
    async guest(name: string, email: string, accessFor = "never"): Promise<Person> {
      const person = await base.signUp(name, email);
      await base.db.insert(schema.member).values({
        id: crypto.randomUUID(),
        organizationId: ada.orgId,
        userId: person.userId,
        role: "member",
        directRole: "member",
        createdAt: new Date(),
      });
      const res = await api("POST", `/threads/${thread}/guests`, ada.cookie, {
        userId: person.userId,
        accessFor,
      });
      if (res.status !== 200) throw new Error(`no guest: ${res.status} ${await res.text()}`);
      return { ...person, orgId: ada.orgId };
    },

    // Takes the person's place in the thread's space away, as nothing in the app does yet for a
    // person's own space.
    async loses(who: Person) {
      await Promise.resolve(
        await base.spaceStore.revoke(base.space.id, { kind: "user", id: who.userId }),
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
      const { items } = await json<{ items: ActivityItem[] }>(
        await api("GET", `/threads/${threadId}/activity`, who.cookie),
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
      return (await Promise.resolve(await call.boundary())).map(
        (message) => `${message.role}: ${"text" in message ? message.text : ""}`,
      );
    },

    // Whether the thread's agent has a call to the model the test has not taken yet.
    waitsForModel: (threadId = thread) =>
      model.calls.some(
        (candidate) => !taken.has(candidate) && candidate.request.sessionId === threadId,
      ),

    // How many calls the model has been made in the thread.
    modelCalls: (threadId = thread) =>
      model.calls.filter((call) => call.request.sessionId === threadId).length,

    // Waits until no run is under way anywhere.
    async settled() {
      await current.idle();
    },

    tool,

    // What the call printed so far, as is kept of it for those watching.
    async printed(callId: string) {
      return (await base.live.tail(callId))?.text ?? "";
    },

    // Moves the clock on and fires what came due, answering how many fired.
    async later(ms: number) {
      base.clock.now = new Date(base.clock.now.getTime() + ms);
      return Promise.resolve(await base.schedules.tick());
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
        // What it sends until it has beaten so many times.
        async until(beats: number) {
          const sent: ReturnType<typeof read>[] = [];
          while (beats > 0) {
            const frame = await stream.next();
            if (frame.comment === "heartbeat") beats -= 1;
            else if (frame.data) sent.push(read(frame));
          }
          return sent;
        },
        async close() {
          await stream.close();
        },
      };
    },

    // Opens the reader's list feed, in the org named when one is. Answers a way to read what it
    // sends, one event at a time, with its name and data, and a way to close it; it listens once
    // `ready` is answered.
    async feed(who: Person = ada, org?: string) {
      const feed = await openFeed(base.app, who.cookie, org);
      const read = (frame: { event?: string; data?: string }) => {
        const event = frame.event as keyof typeof STREAMS.feed.events;
        const schema = STREAMS.feed.events[event];
        if (!schema) throw new Error(`the list feed sent an unknown event: ${frame.event}`);
        return { event, data: schema.parse(JSON.parse(frame.data!)) as Record<string, any> };
      };
      return {
        // Waits for its first beat, by which it listens.
        async ready() {
          while ((await feed.next()).comment !== "heartbeat");
        },
        async next() {
          return read(await feed.nextItem());
        },
        // The next event that holds, passing over others.
        async nextThat(holds: (item: ReturnType<typeof read>) => boolean) {
          for (;;) {
            const item = read(await feed.nextItem());
            if (holds(item)) return item;
          }
        },
        // What it sends until it has beaten so many times.
        async until(beats: number) {
          const sent: ReturnType<typeof read>[] = [];
          while (beats > 0) {
            const frame = await feed.next();
            if (frame.comment === "heartbeat") beats -= 1;
            else if (frame.data) sent.push(read(frame));
          }
          return sent;
        },
        async close() {
          await feed.close();
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

    // Has the org's provider offer one more model.
    async offers(ref: string) {
      await base.models.offer([ref]);
    },

    // Another server instance on the same database, as a second process would be, reached over
    // HTTP. It runs nothing itself; the two hear each other from then on.
    async elsewhere() {
      await base.sync.start();
      const other = setup({}, { database: base.database, toolsets: [tool.toolset] });
      await other.sync.start();
      return {
        async act(who: Person, method: string, path: string, body?: object, threadId = thread) {
          return (await other.api(method, `/threads/${threadId}${path}`, who.cookie, body)).status;
        },
      };
    },

    // Another server instance on the same database, reached over HTTP, whose hints this one never
    // hears, as when its notifications are lost without a gap being told. It runs nothing itself.
    async deaf() {
      const other = setup({}, { database: base.database, toolsets: [tool.toolset] });
      return {
        async act(who: Person, method: string, path: string, body?: object, threadId = thread) {
          return (await other.api(method, `/threads/${threadId}${path}`, who.cookie, body)).status;
        },
      };
    },

    // A thread in Grace's own space in a team org Ada owns, where the org's settings can archive
    // the space and Grace can put it in trash. Each request names the team org.
    async teamThread() {
      const { orgId } = await json<{ orgId: string }>(
        await api("POST", "/orgs", ada.cookie, { name: "Analytical Engines" }),
      );
      const owner: Person = { ...ada, orgId };
      const member: Person = { ...grace, orgId };
      const as = (who: Person, method: string, path: string, body?: object) =>
        api(method, path, who.cookie, body, orgId);
      const { url } = await json<{ url: string }>(
        await as(owner, "POST", "/org/invites", { email: "grace@example.com", role: "member" }),
      );
      await json(
        await api("POST", "/org-invites/accept", grace.cookie, { token: url.split("/join/")[1] }),
      );
      const allow = async (memberSpaces: boolean) =>
        (await as(owner, "PATCH", "/org/settings", { memberSpaces })).status;
      await allow(true);
      const space = await json<{ id: string }>(await as(member, "POST", "/spaces/mine"));
      const made = await json<{ id: string }>(
        await as(member, "POST", `/spaces/${space.id}/threads`, {}),
      );
      const threadId = made.id;
      return {
        threadId,
        ada: owner,
        grace: member,
        async post(text: string) {
          return (await as(member, "POST", `/threads/${threadId}/messages`, { text })).status;
        },
        async decide(callId: string, allowed: boolean) {
          const path = `/threads/${threadId}/tools/${callId}/decision`;
          return (await as(member, "POST", path, { allow: allowed, scope: "once" })).status;
        },
        async shown() {
          const detail = await json<ThreadDetail>(await as(member, "GET", `/threads/${threadId}`));
          return {
            rows: detail.rows.map(rowWords),
            run: detail.run ? (detail.run.waiting ?? "running") : null,
          };
        },
        // The thread's status for Grace, as its page asks for it.
        async status() {
          return (await as(member, "GET", `/threads/${threadId}`)).status;
        },
        // Ada turns members' own spaces off, which archives the space.
        archive: async () => allow(false),
        trash: async () => (await as(member, "DELETE", `/spaces/${space.id}`)).status,
        restore: async () => (await as(member, "POST", `/spaces/trash/${space.id}/restore`)).status,
        deleteOrg: async () => (await as(owner, "DELETE", "/org")).status,
      };
    },

    // Has the server find the jobs a stopped server left running, as it does once their holder
    // has been gone long enough.
    async crashJobs() {
      await expireLeases(base.db, "call");
      await Promise.resolve(await base.calls.recover());
    },

    // Does the work with no worker running, as while every instance is busy elsewhere, then
    // starts one again.
    async whileStopped(work: () => Promise<void>) {
      await current.stop();
      try {
        await work();
      } finally {
        current = base.makeWorker();
        await Promise.resolve(await base.start(current));
      }
    },

    // Stops the server's worker as a crash would, mid-run, and brings up another that recovers
    // what it left.
    async crash() {
      await current.stop();
      current = base.makeWorker();
      await Promise.resolve(await current.recover());
      await Promise.resolve(await base.start(current));
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
      setUp<{ id: string; url: string }>("webhooks.add", { name, note }, true),
    // A wake-up timer the agent set, to go off in so many seconds.
    wakeUp: (seconds: number, note: string) =>
      setUp<{ id: string }>("schedules.wake_at", { in_seconds: seconds, note }),
    // What the schedule or webhook has fired, newest first, as its history lists it.
    async history(who: Person, kind: "schedules" | "webhooks", id: string) {
      return json<FiredHistory>(
        await api("GET", `/threads/${thread}/${kind}/${id}/history`, who.cookie),
      );
    },
    // A schedule the agent made, by cron expression.
    schedule: (name: string, cron: string, prompt: string) =>
      setUp<{ id: string }>("schedules.add", { name, cron, prompt }),
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
      return `${row.toolId} ${row.state}${row.work ? ` [${row.work.status}]` : ""}`;
    case "notice":
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
