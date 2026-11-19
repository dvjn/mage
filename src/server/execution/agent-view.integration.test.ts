import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createMemoryStore } from "@/server/memory/store.ts";
import * as schema from "@/server/schema.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { MCP_ORIGIN } from "@/server/testing/workspace.ts";
import { MCP_BEARER_TOKEN } from "../../../mock/mcp.ts";
import type { AnyToolSpec, Toolset } from "@/server/tools/registry.ts";
import { transcriptOf } from "@/shared/transcript.ts";

// A toolset whose tools say which they are and what they were given; the test may reshape or
// rename one, take one away, or act whenever the space's tools are read.
function echoes() {
  const echo = (name: string): AnyToolSpec => ({
    name,
    title: name,
    description: "Says which tool it is and what it was given.",
    input: z.object({ n: z.number() }),
    risk: () => "normal",
    run: async (input: unknown) => Promise.resolve({ ok: true, value: { tool: name, input } }),
  });
  const say = echo("echo.say");
  const shaped = echo("echo.shaped");
  const gone = echo("echo.gone");
  const hooks: { onRead?: () => Promise<void> } = {};
  const toolset: Toolset = {
    id: "echo",
    title: "Echo",
    source: "builtin",
    tools: [say, shaped, gone],
    load: async () => {
      const read = hooks.onRead;
      hooks.onRead = undefined;
      await read?.();
      return null;
    },
  };
  return { toolset, say, shaped, gone, hooks };
}

async function viewThread(now?: () => Date) {
  const echo = echoes();
  const t = await agentThread(now ? { now } : {}, { toolsets: [echo.toolset] });
  await t.start();
  // Has the agent answer a message with a reply that calls nothing; the request it was sent.
  const exchange = async (text: string) => {
    await t.post(t.ada, text);
    const call = await t.model.next();
    call.reply("Done.");
    await t.worker.idle();
    return call.request;
  };
  // Has the agent call the tools in one step, then answer; what the calls gave back.
  const calling = async (text: string, ...asked: [string, unknown][]) => {
    await t.post(t.ada, text);
    const asking = await t.model.next();
    asking.startStep();
    for (const [index, [toolId, input]] of asked.entries()) {
      asking.toolCall(`c${index}-${text}`, toolId, input);
    }
    asking.endStep();
    asking.end();
    const answered = await t.model.next();
    answered.reply("Done.");
    await t.worker.idle();
    return {
      request: asking.request,
      results: answered.texts.filter((line) => line.startsWith("result")),
    };
  };
  const reasons = async () =>
    (await t.events()).flatMap((event) =>
      event.type === "agent.viewed" ? [(event.data as { reason: string }).reason] : [],
    );
  const instruct = async (text: string, spaceId = t.space.id) =>
    t.api("PUT", `/spaces/${spaceId}/instructions`, t.ada.cookie, { text });
  const toolIds = (request: { tools?: { id: string }[] }) =>
    (request.tools ?? []).map((tool) => tool.id);
  return { ...t, ...echo, exchange, calling, reasons, instruct, toolIds };
}

describe("what a thread's agent reads besides the thread", () => {
  it("stays byte for byte the same across changes to its space, which a new thread reads", async () => {
    const t = await viewThread();
    const first = await t.exchange("One");
    expect(t.toolIds(first)).toContain("echo.say");

    await t.instruct("Cite ids.");
    await t.toolSettings.setInOrg(t.ada.orgId, ["echo.say"], "off");
    const second = await t.exchange("Two");
    expect(second.instructions).toBe(first.instructions);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.searchable)).toBe(JSON.stringify(first.searchable));
    expect(await t.reasons()).toEqual(["start"]);

    const other = await t.createThread(t.ada.cookie, t.space.id, "Hello");
    const fresh = await t.model.next();
    expect(fresh.request.sessionId).toBe(other.id);
    expect(fresh.request.instructions).toContain("Cite ids.");
    expect(t.toolIds(fresh.request)).not.toContain("echo.say");
    fresh.reply("Hi.");
    await t.worker.idle();
  });

  it("is read again on /reload, which is told in the thread and starts nothing", async () => {
    const t = await viewThread();
    await t.exchange("One");
    await t.instruct("Cite ids.");
    await t.toolSettings.setInOrg(t.ada.orgId, ["echo.say"], "off");

    await t.reload(t.grace);
    await t.worker.idle();
    expect(await t.runs()).toHaveLength(1);
    expect((await t.transcript()).at(-1)).toBe("notice");

    const after = await t.exchange("Two");
    expect(after.instructions).toContain("Cite ids.");
    expect(t.toolIds(after)).not.toContain("echo.say");
    expect(JSON.stringify(after.messages)).toContain(
      "Grace Hopper reloaded the agent's tools and instructions",
    );
    expect(await t.reasons()).toEqual(["start", "reload"]);
  });

  it("is reloaded by a guest of the thread too", async () => {
    const t = await viewThread();
    await t.exchange("One");
    const joan = await t.signUp("Joan Clarke", "joan@example.com");
    await t.db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: t.ada.orgId,
      userId: joan.userId,
      role: "member",
      directRole: "member",
      createdAt: new Date(),
    });
    const added = await t.api("POST", `/threads/${t.thread.id}/guests`, t.ada.cookie, {
      userId: joan.userId,
      accessFor: "never",
    });
    expect(added.status).toBe(200);
    await t.instruct("Cite ids.");

    await t.reload(joan);
    const after = await t.exchange("Two");
    expect(after.instructions).toContain("Cite ids.");
    expect(JSON.stringify(after.messages)).toContain(
      "Joan Clarke reloaded the agent's tools and instructions",
    );
  });

  it("is not reloaded before the thread has a message", async () => {
    const t = await viewThread();
    const res = await t.api("POST", `/threads/${t.thread.id}/messages`, t.ada.cookie, {
      text: "/reload",
      command: { name: "reload", args: "" },
    });
    expect(res.status).toBe(409);
    expect(await t.types()).toEqual([]);
  });

  it("is read again after a reload made while it was being taken", async () => {
    const t = await viewThread();
    // Posted once the transcript the view is taken from was read, before the view is kept.
    t.hooks.onRead = async () => {
      await t.instruct("Cite ids.");
      await t.reload(t.ada);
    };
    await t.exchange("One");

    const after = await t.exchange("Two");
    expect(after.instructions).toContain("Cite ids.");
    expect(await t.reasons()).toEqual(["start", "reload"]);
  });

  it("is taken of the thread's new space once it moves, and none of the old space's reaches it", async () => {
    const t = await viewThread();
    await t.instruct("Old space says.");
    expect((await t.exchange("One")).instructions).toContain("Old space says.");
    const other = await t.createSpace(t.ada.cookie, "Other");
    await t.instruct("New space says.", other.id);

    const moved = await t.api("POST", `/threads/${t.thread.id}/move`, t.ada.cookie, {
      spaceId: other.id,
    });
    expect(moved.status).toBe(200);
    const after = await t.exchange("Two");
    expect(after.instructions).toContain("New space says.");
    expect(after.instructions).not.toContain("Old space says.");
    expect(await t.reasons()).toEqual(["start", "move"]);
  });

  it("is kept through a long idle gap", async () => {
    let at = new Date();
    const t = await viewThread(() => at);
    const first = await t.exchange("One");
    await t.instruct("Cite ids.");
    at = new Date(Date.now() + 24 * 60 * 60_000);

    const later = await t.exchange("Two");
    expect(later.instructions).toBe(first.instructions);
    expect(JSON.stringify(later.messages)).not.toContain("were reloaded");
    expect(await t.reasons()).toEqual(["start"]);
  });

  it("is read again after a compaction, which tells the space's memory again", async () => {
    const t = await viewThread();
    await createMemoryStore(t.db).create({
      id: "m1",
      spaceId: t.space.id,
      type: "fact",
      topic: "Build",
      text: "The build needs Node 26.",
      threadId: null,
      callId: null,
      influence: [],
      approvedBy: t.ada.userId,
      supersedesId: null,
    });
    const first = await t.exchange("One");
    expect(JSON.stringify(first.messages)).toContain("The build needs Node 26.");
    await t.exchange("Two");
    await t.instruct("Cite ids.");

    const compacting = await t.api("POST", `/threads/${t.thread.id}/messages`, t.ada.cookie, {
      text: "/compact",
      command: { name: "compact", args: "" },
    });
    expect(compacting.status).toBe(202);
    const summarising = await t.model.next();
    // The summary is asked for as the last request was, so it reads what the cache holds.
    expect(summarising.request.instructions).toBe(first.instructions);
    summarising.reply("Ada counted.");
    await t.worker.idle();

    const after = await t.exchange("Three");
    expect(after.instructions).toContain("Cite ids.");
    expect(
      after.messages.filter((message) => JSON.stringify(message).includes("Node 26")),
    ).toHaveLength(1);
    expect(await t.reasons()).toEqual(["start", "compaction"]);
  });

  // Intended: a branch reads the view its own history holds, which the provider may still cache;
  // a reload made after where it starts is carried to it, as other notices are, and applies there.
  it("is kept by a branch from its own history, which a carried reload retakes", async () => {
    const t = await viewThread();
    await t.exchange("One");
    await t.instruct("Cite ids.");
    await t.exchange("Two");
    const restore = async () => {
      const reply = transcriptOf(await t.events()).rows.find((row) => row.kind === "agent")!;
      const res = await t.api("POST", `/threads/${t.thread.id}/history`, t.ada.cookie, {
        action: "restore",
        rowId: reply.id,
      });
      expect(res.status).toBe(200);
    };

    await restore();
    expect((await t.exchange("Again")).instructions).not.toContain("Cite ids.");

    await t.reload(t.ada);
    await restore();
    const carried = await t.exchange("Once more");
    expect(carried.instructions).toContain("Cite ids.");
    expect(JSON.stringify(carried.messages)).toContain("Ada Lovelace reloaded");
  });

  it("names tools whose calls are judged as they are now: off, gone, or reshaped", async () => {
    const t = await viewThread();
    await t.exchange("One");
    await t.toolSettings.setInOrg(t.ada.orgId, ["echo.say"], "off");
    t.toolset.tools = t.toolset.tools.filter((spec) => spec !== t.gone);
    t.shaped.input = z.object({ text: z.string() });

    const { request, results } = await t.calling(
      "Two",
      ["echo.say", { n: 1 }],
      ["echo.gone", { n: 2 }],
      ["echo.shaped", { n: 3 }],
    );
    expect(t.toolIds(request)).toEqual(
      expect.arrayContaining(["echo.say", "echo.gone", "echo.shaped"]),
    );
    expect(results).toEqual([
      expect.stringContaining("echo__say is off here."),
      expect.stringContaining("No tool is named echo__gone here."),
      expect.stringContaining("The input is not valid"),
    ]);
  });

  it("names tools for scripts as the model was shown them", async () => {
    const t = await viewThread();
    await t.exchange("One");
    // Renamed since: the name the model saw now belongs to another tool.
    t.say.modelName = "echo.renamed";
    t.shaped.modelName = "echo.say";

    const { results } = await t.calling("Two", [
      "scripts.run",
      { code: 'await call_tool("echo__say", {"n": 1})' },
    ]);
    expect(results).toEqual([expect.stringContaining('"tool":"echo.say"')]);
  });
});

describe("a server's tools the thread still lists", () => {
  it("are refused live once the server is gone: neither turned on nor called", async () => {
    const t = await viewThread();
    const added = (await (
      await t.api("POST", "/org/mcp-servers", t.ada.cookie, {
        name: "Notes",
        url: `${MCP_ORIGIN}/headers/mcp`,
        auth: {
          kind: "headers",
          headers: [{ name: "Authorization", value: `Bearer ${MCP_BEARER_TOKEN}` }],
        },
      })
    ).json()) as { id: string };
    const first = await t.exchange("One");
    expect(first.instructions).toContain("mcp__notes__echo");

    await t.api("DELETE", `/mcp-servers/${added.id}`, t.ada.cookie);
    const { request, results } = await t.calling(
      "Two",
      ["mcp_servers.search_tools", { select: ["echo"] }],
      ["mcp.notes.echo", { text: "hi" }],
    );
    expect(request.instructions).toBe(first.instructions);
    expect(results).toEqual([
      expect.stringContaining("is off here."),
      expect.stringContaining("No tool is named mcp__notes__echo here."),
    ]);
  });
});
