// The stand-in model as Anthropic's Messages API: named events opening a content block for its
// thinking, its text and each tool call in turn, then the stop reason with the usage.

import {
  conversationBuilder,
  type Conversation,
  type Encoder,
  type Frame,
  idOf,
  type Protocol,
  textOf,
} from "./wire.ts";

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface MessagesRequest {
  model?: string;
  system?: unknown;
  messages?: { role: string; content: string | Block[] }[];
  tools?: { name?: string; type?: string }[];
}

function read(body: unknown): Conversation {
  const request = (body ?? {}) as MessagesRequest;
  const conversation = conversationBuilder();
  for (const message of request.messages ?? []) {
    const blocks: Block[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    if (message.role === "assistant") {
      conversation.assistant(
        text,
        blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => ({ id: block.id ?? "", name: block.name ?? "", input: block.input })),
      );
      continue;
    }
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const content = textOf(block.content);
      let output: unknown = content;
      try {
        output = JSON.parse(content);
      } catch {
        // Kept as the text it is.
      }
      conversation.result(block.tool_use_id ?? "", output, block.is_error === true);
    }
    conversation.user(text);
  }
  return {
    model: request.model ?? "",
    instructions: textOf(request.system),
    messages: conversation.messages,
    // Its own tools, such as its tool search, are not the ones a script calls.
    tools: (request.tools ?? []).flatMap((tool) =>
      tool.type && tool.type !== "custom" ? [] : (tool.name ?? []),
    ),
  };
}

function encoder(model: string): Encoder {
  let index = -1;
  let open: "thinking" | "text" | null = null;
  const event = (data: { type: string } & Record<string, unknown>): Frame => ({
    event: data.type,
    data,
  });
  function close(): Frame[] {
    if (open === null) return [];
    const frames = [
      ...(open === "thinking"
        ? [
            event({
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: "stand-in" },
            }),
          ]
        : []),
      event({ type: "content_block_stop", index }),
    ];
    open = null;
    return frames;
  }
  function opening(kind: "thinking" | "text"): Frame[] {
    if (open === kind) return [];
    const closed = close();
    index += 1;
    open = kind;
    return [
      ...closed,
      event({
        type: "content_block_start",
        index,
        content_block:
          kind === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" },
      }),
    ];
  }
  return {
    start: () => [
      event({
        type: "message_start",
        message: {
          id: idOf("msg_"),
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
    ],
    reasoning: (piece) => [
      ...opening("thinking"),
      event({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: piece },
      }),
    ],
    text: (piece) => [
      ...opening("text"),
      event({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }),
    ],
    fail: (message) => [
      ...close(),
      event({ type: "error", error: { type: "api_error", message } }),
    ],
    finish: (calls, usage) => [
      ...close(),
      ...calls.flatMap((call) => {
        index += 1;
        return [
          event({
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: idOf("toolu_"), name: call.toolName, input: {} },
          }),
          event({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          }),
          event({ type: "content_block_stop", index }),
        ];
      }),
      event({
        type: "message_delta",
        delta: { stop_reason: calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.outputTokens },
      }),
      event({ type: "message_stop" }),
    ],
  };
}

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
};

export const anthropic: Protocol = {
  read,
  encoder,
  refusal: (code, message) => ({
    type: "error",
    error: { type: TYPES[code] ?? "api_error", message },
  }),
};
