import { describe, expect, it } from "vite-plus/test";

import { promptArguments, promptHint, promptText } from "@/server/mcp/prompts.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { MCP_ORIGIN } from "@/server/testing/workspace.ts";
import { commandOf, type ThreadCommand } from "@/shared/threads/commands.ts";
import type { ThreadDetail } from "@/shared/threads/detail.ts";

import { MCP_BEARER_TOKEN, mcpStandIn, NOTES_GUIDE } from "../../../e2e/mcp-server.ts";
import { skillText } from "./commands.ts";

const greet = {
  name: "greet",
  arguments: [
    { name: "name", required: true },
    { name: "tone", required: false },
  ],
};

// Ada's thread with a skill written for the org and the stand-in MCP server added to it.
async function withCommands() {
  const thread = await agentThread();
  const { api, ada } = thread;
  const skill = await api("POST", "/org/skills", ada.cookie, {
    name: "pirate",
    description: "Talk like a pirate",
    body: "Say arr to $ARGUMENTS.",
  });
  expect(skill.status).toBe(200);
  const server = await api("POST", "/org/mcp-servers", ada.cookie, {
    name: "Notes",
    url: `${MCP_ORIGIN}/headers/mcp`,
    auth: {
      kind: "headers",
      headers: [{ name: "Authorization", value: `Bearer ${MCP_BEARER_TOKEN}` }],
    },
  });
  expect(server.status).toBe(200);
  const { id: serverId } = (await server.json()) as { id: string };
  async function commands(who: { cookie: string }) {
    const res = await api("GET", `/threads/${thread.thread.id}/commands`, who.cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as ThreadCommand[];
  }
  function send(who: { cookie: string }, text: string, command: object, mode = "steer") {
    return api("POST", `/threads/${thread.thread.id}/messages`, who.cookie, {
      text,
      mode,
      command,
    });
  }
  return { ...thread, serverId, commands, send };
}

describe("a message's command", () => {
  it("is its first word after a slash, and what follows it", () => {
    expect(commandOf("/deploy  staging now ")).toEqual({ name: "deploy", args: "staging now" });
    expect(commandOf("/notes:greet Ada\nwarmly")).toEqual({
      name: "notes:greet",
      args: "Ada\nwarmly",
    });
    expect(commandOf("/compact")).toEqual({ name: "compact", args: "" });
    expect(commandOf("// an aside")).toBeNull();
    expect(commandOf("hello /deploy")).toBeNull();
    expect(commandOf("/")).toBeNull();
  });
});

describe("a skill as a command", () => {
  const skill = {
    name: "pirate",
    body: "Say arr to $ARGUMENTS, then $ARGUMENTS again.",
    files: [],
  };

  it("puts the words after its name in place of $ARGUMENTS", () => {
    const text = skillText(skill, "Grace", "/pirate Grace");
    expect(text.startsWith("/pirate Grace\n\n")).toBe(true);
    expect(text).toContain("This runs the skill pirate.");
    expect(text.endsWith("Say arr to Grace, then Grace again.")).toBe(true);
  });

  it("adds the words after its instructions when they take none", () => {
    const plain = {
      name: "haiku",
      body: "Write three lines.",
      files: [{ path: "a.md", text: "" }],
    };
    expect(skillText(plain, "about rain", "/haiku about rain")).toMatch(
      /Its files, to read as you need them: a\.md\.\n\nWrite three lines\.\n\nARGUMENTS: about rain$/,
    );
    expect(skillText(plain, "", "/haiku").endsWith("Write three lines.")).toBe(true);
  });
});

describe("a prompt as a command", () => {
  it("takes one word for each argument in order, the last taking the rest", () => {
    expect(promptArguments(greet, "Ada in a warm tone")).toEqual({
      values: { name: "Ada", tone: "in a warm tone" },
      missing: [],
    });
    expect(promptArguments({ name: "one", arguments: [greet.arguments[0]!] }, " Ada  B ")).toEqual({
      values: { name: "Ada  B" },
      missing: [],
    });
    expect(promptArguments(greet, "")).toEqual({ values: {}, missing: ["name"] });
    expect(promptHint(greet)).toBe("<name> [tone]");
    expect(promptHint({ name: "none", arguments: [] })).toBeNull();
  });

  it("reads as its user messages' text and embedded text, naming anything else", () => {
    expect(
      promptText({
        messages: [
          { role: "user", content: { type: "text", text: "Hello" } },
          { role: "user", content: { type: "resource", resource: { uri: "a", text: "Guide" } } },
          { role: "user", content: { type: "image", mimeType: "image/png", data: "AA" } },
          { role: "assistant", content: { type: "text", text: "Hidden" } },
        ],
      }),
    ).toBe("Hello\n\nGuide\n\n[image image/png]\n\n[a message from the assistant]");
  });
});

describe("thread commands", () => {
  it("lists the space's skills and its servers' prompts to those who can post, none to viewers", async () => {
    const { ada, grace, alan, commands } = await withCommands();
    const expected = [
      {
        name: "compact",
        description: "Summarise earlier messages for the agent",
        argumentHint: "[focus]",
        kind: "builtin",
        tag: null,
      },
      {
        name: "pirate",
        description: "Talk like a pirate",
        argumentHint: null,
        kind: "skill",
        tag: "Skill",
      },
      {
        name: "notes:greet",
        description: "Greet someone by name.",
        argumentHint: "<name> [tone]",
        kind: "prompt",
        tag: "Notes",
      },
    ];
    expect(await commands(ada)).toEqual(expected);
    expect(await commands(grace)).toEqual(expected);
    expect(await commands(alan)).toEqual([]);
  });

  it("captures a server's prompts when it is read, and again on refresh", async () => {
    const { ada, api, serverId, mcpNetwork, mcpServerStore } = await withCommands();
    expect(mcpServerStore.find(serverId)?.prompts.map((prompt) => prompt.name)).toEqual(["greet"]);
    mcpNetwork.handle = mcpStandIn({ origin: MCP_ORIGIN, prompts: false });
    const res = await api("POST", `/mcp-servers/${serverId}/refresh`, ada.cookie);
    expect(res.status).toBe(200);
    expect(mcpServerStore.find(serverId)?.prompts).toEqual([]);
  });

  it("sends a skill as what its instructions say with the words given", async () => {
    const { ada, send, model, worker, start, transcript, thread, api } = await withCommands();
    start();
    const res = await send(ada, "/pirate Grace", { name: "pirate", args: "Grace" });
    expect(res.status).toBe(202);
    const call = await model.next();
    expect(call.texts).toEqual([
      expect.stringMatching(
        /^user: \[Ada Lovelace\] \/pirate Grace\n\n.*skill pirate.*\n\nSay arr to Grace\.$/s,
      ),
    ]);
    call.reply("Arr, Grace.");
    await worker.idle();
    expect(transcript()[0]).toBe("Ada Lovelace: /pirate Grace");
    // Readers see the command as typed, not what the agent read for it.
    const detail = (await (
      await api("GET", `/threads/${thread.id}`, ada.cookie)
    ).json()) as ThreadDetail;
    expect(detail.rows[0]).toMatchObject({ command: { name: "pirate", args: "Grace" } });
    expect(JSON.stringify(detail.rows[0])).not.toContain("Say arr");
  });

  it("gets a server's prompt with the arguments given, and refuses one missing any it needs", async () => {
    const { ada, send, model, worker, start, types } = await withCommands();
    start();
    const missing = await send(ada, "/notes:greet", { name: "notes:greet", args: "" });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("/notes:greet needs name");
    expect(types()).toEqual([]);

    const res = await send(ada, "/notes:greet Ada warmly", {
      name: "notes:greet",
      args: "Ada warmly",
    });
    expect(res.status).toBe(202);
    const call = await model.next();
    const [text] = call.texts;
    expect(text).toContain("the prompt greet from the MCP server Notes");
    expect(text).toContain("Hello, Ada, warmly!");
    expect(text).toContain(NOTES_GUIDE);
    expect(text).toContain("[image image/png]");
    call.reply("Hi.");
    await worker.idle();
  });

  it("refuses a command the thread does not have, while a slash word alone goes as plain text", async () => {
    const { ada, send, post, model, worker, start, transcript } = await withCommands();
    start();
    const res = await send(ada, "/deploy now", { name: "deploy", args: "now" });
    expect(res.status).toBe(400);
    await post(ada, "/tool thread.info {}");
    const call = await model.next();
    expect(call.texts).toEqual(["user: [Ada Lovelace] /tool thread.info {}"]);
    call.reply("Done.");
    await worker.idle();
    expect(transcript()).toEqual([
      "Ada Lovelace: /tool thread.info {}",
      "Agent (completed): Done.",
    ]);
  });

  it("can't be edited while it waits, only removed", async () => {
    const { ada, post, send, model, start, api, thread, pending } = await withCommands();
    start();
    await post(ada, "Hello");
    const call = await model.next();
    const res = await send(ada, "/pirate Alan", { name: "pirate", args: "Alan" }, "queue");
    const { id } = (await res.json()) as { id: string };
    expect(pending()).toEqual(["Ada Lovelace (queue): /pirate Alan"]);
    const edit = await api("PATCH", `/threads/${thread.id}/messages/${id}`, ada.cookie, {
      text: "/pirate Grace",
    });
    expect(edit.status).toBe(409);
    const removed = await api("DELETE", `/threads/${thread.id}/messages/${id}`, ada.cookie);
    expect(removed.status).toBe(200);
    expect(pending()).toEqual([]);
    call.reply("Hi.");
  });
});
