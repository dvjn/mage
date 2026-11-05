import { describe, expect, it } from "vite-plus/test";

import { instructionsFor } from "@/server/agent/context.ts";
import type { Instructions, SpaceInstructions } from "@/shared/instructions.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { setup } from "@/server/testing/workspace.ts";

async function json<T>(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

describe("the system prompt", () => {
  it("is the agent's own prompt, then the org's instructions, then the space's", () => {
    const prompt = instructionsFor({ org: "Be brief.", space: "Use British spelling." });
    const at = (text: string) => prompt.indexOf(text);
    expect(at("You are the agent in a thread")).toBe(0);
    expect(at("Instructions from the organization:\nBe brief.")).toBeGreaterThan(0);
    expect(at("Instructions from this space:\nUse British spelling.")).toBeGreaterThan(
      at("Be brief."),
    );
  });

  it("follows the space's with the built-in toolsets' guidance, then each MCP server's, framed as the server's", () => {
    const prompt = instructionsFor({
      org: "Be brief.",
      space: "Cite ids.",
      mcpServers: [
        { name: "Notes", prefix: "mcp.notes.*", text: "Title every note.", cut: false },
        { name: "Wiki", prefix: "mcp.wiki.*", text: "Search first", cut: true },
      ],
      toolsets: [
        { name: "Rich replies", text: "Lay it out." },
        { name: "Subagents", prefix: "subagents", text: "Start them." },
      ],
    });
    const at = (text: string) => prompt.indexOf(text);
    expect(prompt).toContain(
      "Cite ids.\n\nRich replies:\nLay it out.\n\nSubagents (`subagents__*`):\nStart them.",
    );
    expect(at("MCP servers describe their own tools")).toBeGreaterThan(at("Start them."));
    expect(prompt).toContain("not the organization's: the instructions above win");
    expect(prompt).toContain("From Notes (`mcp__notes__*`):\nTitle every note.");
    expect(prompt).toContain("From Wiki (`mcp__wiki__*`):\nSearch first\n(Cut short.)");
  });

  it("gives its sections in order", () => {
    const prompt = instructionsFor({
      org: "Org says.",
      space: "Space says.",
      agentName: "Mira",
      toolsets: [{ name: "Subagents", prefix: "subagents", text: "Builtin says." }],
      mcpServers: [{ name: "Notes", prefix: "mcp.notes.*", text: "Server says.", cut: false }],
      deferredTools: [
        {
          server: "Notes",
          prefix: "mcp.notes",
          tools: [{ name: "mcp.notes.find", description: "Find notes" }],
        },
      ],
      skills: [{ name: "triage", description: "Sort issues" }],
    });
    const order = [
      "You are the agent",
      "You go by Mira here.",
      "Org says.",
      "Space says.",
      "Subagents (`subagents__*`):\nBuiltin says.",
      "MCP servers describe their own tools",
      "From Notes (`mcp__notes__*`):\nServer says.",
      "MCP tools to turn on",
      "Skills:",
    ].map((text) => prompt.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("says the name the agent goes by after what it is, when it has its own and is not a subagent", () => {
    const named = instructionsFor({ org: "Be brief.", space: "", agentName: "Mira" });
    expect(named).toMatch(/^You are the agent in a thread/);
    expect(named.indexOf("You go by Mira here.")).toBeGreaterThan(0);
    expect(named.indexOf("You go by Mira here.")).toBeLessThan(named.indexOf("Be brief."));
    expect(instructionsFor({ org: "", space: "", agentName: "Agent" })).not.toContain("You go by");
    expect(
      instructionsFor({ org: "", space: "", agentName: "Mira", subagent: true }),
    ).not.toContain("Mira");
  });

  it("is the same for every subagent, whatever its label, starter or instructions", () => {
    const prompt = instructionsFor({ org: "", space: "", subagent: true });
    expect(prompt).toContain("You are a subagent");
    expect(prompt).not.toContain("Instructions for you");
  });

  it("leaves out what is empty", () => {
    const prompt = instructionsFor({ org: " ", space: "", mcpServers: [] });
    expect(prompt).toBe(instructionsFor());
    expect(prompt).not.toContain("Instructions");
    expect(prompt).not.toContain("MCP server");
  });
});

describe("instructions", () => {
  it("are the org owners' to change in the org, read by its members, and a space's managers'", async () => {
    const workspace = setup();
    const { api, signUp, join } = workspace;
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await workspace.yourSpace(ada.cookie);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");

    const refused = await api("PUT", "/org/instructions", grace.cookie, { text: "Hi" }, ada.orgId);
    expect(refused.status).toBe(403);
    await json(await api("PUT", "/org/instructions", ada.cookie, { text: " Be brief. " }));
    const read = await json<Instructions>(
      await api("GET", "/org/instructions", grace.cookie, undefined, ada.orgId),
    );
    expect(read.text).toBe("Be brief.");
    const long = await api("PUT", "/org/instructions", ada.cookie, { text: "x".repeat(50_001) });
    expect(long.status).toBe(400);

    const own = await api("PUT", `/spaces/${space.id}/instructions`, grace.cookie, { text: "Hi" });
    expect(own.status).toBe(403);
    const saved = await json<SpaceInstructions>(
      await api("PUT", `/spaces/${space.id}/instructions`, ada.cookie, { text: "Cite ids." }),
    );
    expect([saved.own.text, saved.org.text]).toEqual(["Cite ids.", "Be brief."]);
  });

  it("reach the agent in its prompt, the org's before the space's", async () => {
    const { ada, api, post, model, worker, start, thread } = await agentThread();
    await json(await api("PUT", "/org/instructions", ada.cookie, { text: "Be brief." }));
    await json(
      await api("PUT", `/spaces/${thread.spaceId}/instructions`, ada.cookie, { text: "Cite ids." }),
    );
    start();
    await post(ada, "Hello");
    const call = await model.next();
    call.reply("Hi.");
    await worker.idle();
    expect(call.request.instructions).toContain(
      "Instructions from the organization:\nBe brief.\n\nInstructions from this space:\nCite ids.",
    );
  });

  it("name neither the product nor anyone in the thread", async () => {
    const { grace, post, model, worker, start } = await agentThread();
    start();
    await post(grace, "Hello");
    const call = await model.next();
    call.reply("Hi.");
    await worker.idle();
    expect(call.request.instructions).not.toContain("Grace");
    expect(call.request.instructions).not.toMatch(/\bmage\b/i);
    expect(call.request.instructions).toContain("start with the writer's name in brackets");
  });
});
