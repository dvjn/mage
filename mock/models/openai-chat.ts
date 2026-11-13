// The stand-in model as an OpenAI Chat Completions server, as OpenAI-compatible servers speak it:
// chunks of deltas with reasoning as `reasoning_content`, tool calls whole in one chunk each, the
// finish reason, then the usage and `[DONE]`.

import {
  conversationBuilder,
  type Conversation,
  type Encoder,
  idOf,
  outputOf,
  type Protocol,
  textOf,
} from "./wire.ts";

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: { function?: { name?: string } }[];
}

function read(body: unknown): Conversation {
  const request = (body ?? {}) as ChatRequest;
  const conversation = conversationBuilder();
  const system: string[] = [];
  for (const message of request.messages ?? []) {
    switch (message.role) {
      case "system":
      case "developer":
        system.push(textOf(message.content));
        break;
      case "user":
        conversation.user(textOf(message.content));
        break;
      case "assistant":
        conversation.assistant(
          textOf(message.content),
          (message.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function.name,
            input: outputOf(call.function.arguments),
          })),
        );
        break;
      case "tool":
        conversation.result(message.tool_call_id ?? "", outputOf(textOf(message.content)));
        break;
    }
  }
  return {
    model: request.model ?? "",
    instructions: system.join("\n\n"),
    messages: conversation.messages,
    tools: (request.tools ?? []).flatMap((tool) => tool.function?.name ?? []),
  };
}

function encoder(model: string): Encoder {
  const id = idOf("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish: string | null = null) => ({
    data: {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    },
  });
  return {
    start: () => [chunk({ role: "assistant", content: "" })],
    reasoning: (piece) => [chunk({ reasoning_content: piece })],
    text: (piece) => [chunk({ content: piece })],
    fail: (message) => [{ data: { error: { message, type: "server_error", code: null } } }],
    finish: (calls, usage) => [
      ...calls.map((call, index) =>
        chunk({
          tool_calls: [
            {
              index,
              id: idOf("call_"),
              type: "function",
              function: { name: call.toolName, arguments: JSON.stringify(call.input) },
            },
          ],
        }),
      ),
      chunk({}, calls.length > 0 ? "tool_calls" : "stop"),
      {
        data: {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        },
      },
    ],
  };
}

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_exceeded",
};

export const openaiChat: Protocol = {
  read,
  encoder,
  refusal: (code, message) => ({
    error: { message, type: TYPES[code] ?? "server_error", code: TYPES[code] ?? null },
  }),
  done: "[DONE]",
};
