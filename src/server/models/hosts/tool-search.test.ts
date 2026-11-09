import { createAnthropic } from "@ai-sdk/anthropic";
import { describe, expect, it } from "vite-plus/test";

import type { ModelGateway, ModelRequest, ModelToken } from "@/server/models/gateway.ts";

import { createBedrockGateway } from "./amazon-bedrock.ts";
import { anthropicErrors, anthropicReply, createAnthropicKeyGateway } from "./anthropic-api.ts";
import { createClaudeGateway } from "./anthropic-claude.ts";
import { createAzureGateway } from "./azure.ts";
import { createVertexGateway } from "./google-vertex.ts";
import { createOpenAIKeyGateway } from "./openai-api.ts";
import { createCodexGateway } from "./openai-codex.ts";
import { createCompatibleGateway } from "./openai-compatible.ts";

type Body = Record<string, unknown>;

// Records each request and refuses it, so that only what was asked for is seen.
function refusingFetch() {
  const requests: { url: string; body: Body }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: (await request.json()) as Body });
    return Response.json({ message: "no" }, { status: 400 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const SEARCH = "mcp_servers.search_tools";
const tool = (id: string) => ({
  id,
  description: `Does ${id}.`,
  inputSchema: { type: "object", properties: {} },
});

// A thread whose MCP tools are left out until the agent searches for them.
const before: Omit<ModelRequest, "model"> = {
  instructions: "You are the agent.",
  messages: [{ role: "user", text: "[Ada Lovelace] Take a note." }],
  maxSteps: 5,
  sessionId: "thread-1",
  tools: [tool("thread.rename"), tool(SEARCH)],
  searchable: [tool("mcp.notes.echo"), tool("mcp.notes.add")],
  search: SEARCH,
};

// The same thread after the agent searched and turned one tool on.
const after: Omit<ModelRequest, "model"> = {
  ...before,
  toolsOn: ["mcp.notes.add"],
  messages: [
    ...before.messages,
    {
      role: "assistant",
      text: "",
      toolCalls: [{ callId: "call_1", toolId: SEARCH, input: { query: "add a note" } }],
    },
    {
      role: "tool",
      results: [
        {
          callId: "call_1",
          toolId: SEARCH,
          output: { ok: true, value: { turnedOn: ["mcp.notes.add"] } },
        },
      ],
    },
    { role: "change", tools: ["mcp.notes.add"] },
    { role: "user", text: "[Ada Lovelace] The engine one." },
  ],
};

// The bodies of the thread's requests before and after the search.
async function sent(gateway: ModelGateway, token: ModelToken, model: string, requests: unknown[]) {
  for (const request of [before, after]) {
    const events = gateway.stream(token, { ...request, model }, new AbortController().signal);
    await expect(
      (async () => {
        for await (const _ of events);
      })(),
    ).rejects.toThrow();
  }
  return requests as { url: string; body: Body }[];
}

// The Messages API's tools without their cache markers, and its messages.
const unmarked = (value: unknown) =>
  JSON.parse(JSON.stringify(value).replaceAll(',"cache_control":{"type":"ephemeral"}', "")) as {
    name?: string;
    defer_loading?: boolean;
  }[];
const ADDED = {
  role: "system",
  content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "mcp__notes__add" } }],
};
const REFERRED = [{ type: "tool_reference", tool_name: "mcp__notes__add" }];

// What a Messages request does with the search: tools the same before and after it, every
// searchable tool declared left out, and the tool turned on by a system message or by the search's
// result.
function expectClaudeSearch(
  [first, second]: { body: Body }[],
  how: "tool_addition" | "tool_reference",
) {
  const tools = unmarked(second!.body.tools);
  expect(tools).toEqual(unmarked(first!.body.tools));
  expect(tools.map((sent) => [sent.name, sent.defer_loading ?? false])).toEqual([
    ["thread__rename", false],
    ["mcp_servers__search_tools", false],
    ["mcp__notes__echo", true],
    ["mcp__notes__add", true],
  ]);
  expect((first!.body.system as unknown[]).at(-1)).toEqual({
    type: "text",
    text: "You are the agent.",
    cache_control: { type: "ephemeral" },
  });
  const messages = unmarked(second!.body.messages) as unknown as {
    role: string;
    content: { type: string; content?: unknown }[];
  }[];
  const result = messages.flatMap((message) => message.content).find((part) => "content" in part);
  if (how === "tool_addition") {
    expect(messages).toContainEqual(ADDED);
    expect(result?.content).not.toEqual(REFERRED);
  } else {
    expect(messages.map((message) => message.role)).not.toContain("system");
    expect(result?.content).toEqual(REFERRED);
  }
}

// What a request that cannot leave tools out does with the search: the tool turned on joins the
// tools after the rest.
function expectAppended([first, second]: string[][]) {
  expect(first).toEqual(["thread__rename", "mcp_servers__search_tools"]);
  expect(second).toEqual(["thread__rename", "mcp_servers__search_tools", "mcp__notes__add"]);
}

describe("Claude's tool search, by host", () => {
  it("on the Anthropic API: tools added mid-conversation, or referred to by the search on a model without that", async () => {
    const { fetchFn, requests } = refusingFetch();
    const gateway = createAnthropicKeyGateway(fetchFn);
    const token = { access: "sk-ant", accountId: null };

    expectClaudeSearch(await sent(gateway, token, "claude-haiku-5-5", requests), "tool_addition");
    requests.length = 0;
    expectClaudeSearch(
      await sent(gateway, token, "claude-haiku-4-5-20251001", requests),
      "tool_reference",
    );
  });

  it("on the Anthropic API: a model without tool search is sent the tool turned on after the rest", async () => {
    const { fetchFn, requests } = refusingFetch();
    const gateway = createAnthropicKeyGateway(fetchFn);

    const bodies = await sent(
      gateway,
      { access: "k", accountId: null },
      "claude-opus-4-1",
      requests,
    );

    expectAppended(bodies.map(({ body }) => unmarked(body.tools).map((sent) => sent.name!)));
  });

  it("with a Claude account: tools added mid-conversation", async () => {
    const { fetchFn, requests } = refusingFetch();

    const bodies = await sent(
      createClaudeGateway(fetchFn),
      { access: "token", accountId: null },
      "claude-sonnet-5-5",
      requests,
    );

    expectClaudeSearch(bodies, "tool_addition");
  });

  it("on Bedrock: through InvokeModel, tools added mid-conversation or referred to by the search", async () => {
    const { fetchFn, requests } = refusingFetch();
    const gateway = createBedrockGateway(fetchFn);
    const token = { access: "bedrock-key", accountId: null, settings: { region: "us-east-1" } };

    const added = await sent(gateway, token, "global.anthropic.claude-haiku-5-5", requests);
    expect(added[0]!.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-haiku-5-5/invoke-with-response-stream",
    );
    expect(added[1]!.body.anthropic_beta).toContain("mid-conversation-tool-changes-2026-07-01");
    expectClaudeSearch(added, "tool_addition");
    requests.length = 0;
    expectClaudeSearch(
      await sent(gateway, token, "us.anthropic.claude-haiku-4-5-20251001-v1:0", requests),
      "tool_reference",
    );
  });

  it("on Vertex AI: tools added mid-conversation, or referred to by the search on a model without that", async () => {
    // What Vertex's Claude is sent, through a provider that needs no service account.
    const { fetchFn, requests } = refusingFetch();
    const provider = createAnthropic({ apiKey: "k", fetch: fetchFn });
    const gateway: ModelGateway = {
      stream: (_token, request, signal) =>
        anthropicReply(provider.messages(request.model), request, signal, {
          system: request.instructions,
          errors: anthropicErrors,
          platform: "vertex",
        }),
    };
    const token = { access: "", accountId: null };

    expectClaudeSearch(
      await sent(gateway, token, "claude-haiku-5-5@default", requests),
      "tool_addition",
    );
    requests.length = 0;
    expectClaudeSearch(
      await sent(gateway, token, "claude-haiku-4-5@20251001", requests),
      "tool_reference",
    );
  });

  it("on Microsoft Foundry: referred to by the search, since it takes no changes mid-conversation", async () => {
    const { fetchFn, requests } = refusingFetch();
    const token = {
      access: "azure-key",
      accountId: null,
      settings: { endpoint: "https://team.services.ai.azure.com" },
    };

    const bodies = await sent(createAzureGateway(fetchFn), token, "claude-sonnet-5-5", requests);

    expectClaudeSearch(bodies, "tool_reference");
  });
});

// What a Responses request does with the search: tools the same before and after it, the search
// offered as the API's own tool search run by Mage, the searchable tools not declared, and the
// search's call and result given back as the tool search's, with the tool turned on.
function expectResponsesSearch([first, second]: { body: Body }[]) {
  expect(second!.body.tools).toEqual(first!.body.tools);
  expect(first!.body.tools).toEqual([
    expect.objectContaining({ type: "function", name: "thread__rename" }),
    {
      type: "tool_search",
      execution: "client",
      description: `Does ${SEARCH}.`,
      parameters: { type: "object", properties: {} },
    },
  ]);
  expect(first!.body).toMatchObject({ store: false, prompt_cache_key: "thread-1" });
  const input = second!.body.input as { type?: string }[];
  expect(input.filter((item) => item.type?.startsWith("tool_search"))).toEqual([
    {
      type: "tool_search_call",
      id: "tsc_1",
      execution: "client",
      call_id: "call_1",
      status: "completed",
      arguments: { query: "add a note" },
    },
    {
      type: "tool_search_output",
      execution: "client",
      call_id: "call_1",
      status: "completed",
      tools: [
        {
          type: "function",
          name: "mcp__notes__add",
          description: "Does mcp.notes.add.",
          parameters: { type: "object", properties: {} },
          defer_loading: true,
        },
      ],
    },
  ]);
}

const functionNames = (body: Body) =>
  (body.tools as { name?: string; function?: { name: string } }[]).map(
    (sent) => sent.name ?? sent.function!.name,
  );

describe("GPT's tool search, by host", () => {
  it("on the OpenAI API: the API's own tool search, from GPT-5.4 on", async () => {
    const { fetchFn, requests } = refusingFetch();
    const gateway = createOpenAIKeyGateway(fetchFn);
    const token = { access: "sk-key", accountId: null };

    expectResponsesSearch(await sent(gateway, token, "gpt-6-luna", requests));
    requests.length = 0;
    const older = await sent(gateway, token, "gpt-5.2", requests);
    expectAppended(older.map(({ body }) => functionNames(body)));
  });

  it("on Azure: the Responses API's own tool search", async () => {
    const { fetchFn, requests } = refusingFetch();
    const token = {
      access: "azure-key",
      accountId: null,
      settings: { endpoint: "https://team.openai.azure.com" },
    };

    expectResponsesSearch(await sent(createAzureGateway(fetchFn), token, "gpt-6-luna", requests));
  });

  it("on Codex: the Responses API's own tool search", async () => {
    const { fetchFn, requests } = refusingFetch();
    const token = { access: "access-token", accountId: "account-1" };

    expectResponsesSearch(await sent(createCodexGateway(fetchFn), token, "gpt-6-luna", requests));
  });

  it("on Bedrock: through Converse, the tool turned on after the rest", async () => {
    const { fetchFn, requests } = refusingFetch();
    const token = { access: "bedrock-key", accountId: null, settings: { region: "us-east-1" } };

    const bodies = await sent(
      createBedrockGateway(fetchFn),
      token,
      "global.openai.gpt-6.1-terra",
      requests,
    );

    expect(bodies[0]!.url).toContain("/converse-stream");
    expectAppended(
      bodies.map(({ body }) =>
        (body.toolConfig as { tools: { toolSpec: { name: string } }[] }).tools.map(
          (sent) => sent.toolSpec.name,
        ),
      ),
    );
  });
});

describe("Other models' tool search", () => {
  it("Gemini on Vertex AI: the tool turned on after the rest", async () => {
    const { fetchFn, requests } = refusingFetch();

    const bodies = await sent(
      createVertexGateway(fetchFn),
      { access: "express-key", accountId: null },
      "gemini-3.8-flash",
      requests,
    );

    expectAppended(
      bodies.map(({ body }) =>
        (body.tools as { functionDeclarations: { name: string }[] }[])[0]!.functionDeclarations.map(
          (sent) => sent.name,
        ),
      ),
    );
  });

  it("an OpenAI-compatible host: the tool turned on after the rest", async () => {
    const { fetchFn, requests } = refusingFetch();

    const bodies = await sent(
      createCompatibleGateway("deepinfra", fetchFn),
      { access: "key", accountId: null },
      "deepseek-ai/DeepSeek-V4",
      requests,
    );

    expectAppended(bodies.map(({ body }) => functionNames(body)));
  });
});
