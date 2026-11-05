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
    expect(at("You are the agent in a workspace")).toBe(0);
    expect(at("Instructions from the organization:\nBe brief.")).toBeGreaterThan(0);
    expect(at("Instructions from this space:\nUse British spelling.")).toBeGreaterThan(
      at("Be brief."),
    );
  });

  it("follows the space's with each MCP server's own, framed as the server's", () => {
    const prompt = instructionsFor({
      org: "Be brief.",
      space: "Cite ids.",
      mcpServers: [
        { name: "Notes", prefix: "mcp.notes.*", text: "Title every note.", cut: false },
        { name: "Wiki", prefix: "mcp.wiki.*", text: "Search first", cut: true },
      ],
      toolsets: ["Rich replies: on."],
    });
    const at = (text: string) => prompt.indexOf(text);
    expect(at("written by MCP servers about their own tools")).toBeGreaterThan(at("Cite ids."));
    expect(prompt).toContain("not the organization's: the instructions above come first");
    expect(prompt).toContain(
      "From the MCP server Notes, about its tools `mcp.notes.*`:\nTitle every note.",
    );
    expect(prompt).toContain(
      "From the MCP server Wiki, about its tools `mcp.wiki.*`:\nSearch first\n(Cut short.)",
    );
    expect(at("Rich replies: on.")).toBeGreaterThan(at("Search first"));
  });

  it("says the name the agent goes by, when it has its own and is not a subagent", () => {
    expect(instructionsFor({ org: "", space: "", agentName: "Mira" })).toMatch(
      /^You are Mira, the agent in a workspace/,
    );
    expect(instructionsFor({ org: "", space: "", agentName: "Agent" })).toMatch(
      /^You are the agent in a workspace/,
    );
    const subagent = { name: "Scout", parent: "Notes" };
    expect(instructionsFor({ org: "", space: "", agentName: "Mira", subagent })).toMatch(
      /^You are the agent in a workspace/,
    );
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
    expect(call.request.instructions).toContain("starts with the writer's name in brackets");
  });
});
