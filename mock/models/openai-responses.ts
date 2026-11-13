// The stand-in model as OpenAI's Responses API, as the OpenAI API, ChatGPT's Codex backend and
// Azure speak it: output items added and done for its reasoning summary, its message and each
// function call, with their deltas between, then the completed response with the usage.

import {
  conversationBuilder,
  type Conversation,
  type Encoder,
  type Frame,
  idOf,
  outputOf,
  type Protocol,
  textOf,
} from "./wire.ts";

interface Item {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
}

interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: string | Item[];
  tools?: { type?: string; name?: string }[];
}

function read(body: unknown): Conversation {
  const request = (body ?? {}) as ResponsesRequest;
  const conversation = conversationBuilder();
  const system = request.instructions ? [request.instructions] : [];
  const items: Item[] =
    typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : (request.input ?? []);
  for (const item of items) {
    if (item.type === "function_call") {
      const call = {
        id: item.call_id ?? "",
        name: item.name ?? "",
        input: outputOf(item.arguments),
      };
      const last = conversation.messages.at(-1);
      // Calls follow the message they came with.
      if (last?.role === "assistant") {
        conversation.messages.pop();
        conversation.assistant(last.text, [
          ...(last.toolCalls ?? []).map((made) => ({
            id: made.callId,
            name: made.toolId,
            input: made.input,
          })),
          call,
        ]);
      } else {
        conversation.assistant("", [call]);
      }
    } else if (item.type === "function_call_output") {
      conversation.result(item.call_id ?? "", outputOf(textOf(item.output) || item.output));
    } else if (item.role === "system" || item.role === "developer") {
      system.push(textOf(item.content));
    } else if (item.role === "user") {
      conversation.user(textOf(item.content));
    } else if (item.role === "assistant") {
      conversation.assistant(textOf(item.content));
    }
  }
  return {
    model: request.model ?? "",
    instructions: system.join("\n\n"),
    messages: conversation.messages,
    tools: (request.tools ?? []).flatMap((tool) =>
      tool.type === "function" && tool.name ? [tool.name] : [],
    ),
  };
}

function encoder(model: string): Encoder {
  const response = { id: idOf("resp_"), created_at: Math.floor(Date.now() / 1000), model };
  let sequence = 0;
  let index = -1;
  let open: { kind: "reasoning" | "message"; id: string; text: string } | null = null;
  const output: object[] = [];
  const event = (data: { type: string } & Record<string, unknown>): Frame => {
    sequence += 1;
    return { event: data.type, data: { ...data, sequence_number: sequence } };
  };
  function close(): Frame[] {
    if (!open) return [];
    const item =
      open.kind === "reasoning"
        ? {
            type: "reasoning",
            id: open.id,
            encrypted_content: null,
            summary: [{ type: "summary_text", text: open.text }],
          }
        : {
            type: "message",
            id: open.id,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: open.text, annotations: [] }],
          };
    output.push(item);
    const frames = [
      ...(open.kind === "reasoning"
        ? [
            event({
              type: "response.reasoning_summary_part.done",
              item_id: open.id,
              output_index: index,
              summary_index: 0,
              part: { type: "summary_text", text: open.text },
            }),
          ]
        : []),
      event({ type: "response.output_item.done", output_index: index, item }),
    ];
    open = null;
    return frames;
  }
  function opening(kind: "reasoning" | "message"): Frame[] {
    if (open?.kind === kind) return [];
    const closed = close();
    index += 1;
    open = { kind, id: idOf(kind === "reasoning" ? "rs_" : "msg_"), text: "" };
    const item =
      kind === "reasoning"
        ? { type: "reasoning", id: open.id, encrypted_content: null, summary: [] }
        : { type: "message", id: open.id, role: "assistant", status: "in_progress", content: [] };
    return [
      ...closed,
      event({ type: "response.output_item.added", output_index: index, item }),
      ...(kind === "reasoning"
        ? [
            event({
              type: "response.reasoning_summary_part.added",
              item_id: open.id,
              output_index: index,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            }),
          ]
        : []),
    ];
  }
  return {
    start: () => [
      event({
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      }),
    ],
    reasoning(piece) {
      const frames = opening("reasoning");
      open!.text += piece;
      return [
        ...frames,
        event({
          type: "response.reasoning_summary_text.delta",
          item_id: open!.id,
          output_index: index,
          summary_index: 0,
          delta: piece,
        }),
      ];
    },
    text(piece) {
      const frames = opening("message");
      open!.text += piece;
      return [
        ...frames,
        event({
          type: "response.output_text.delta",
          item_id: open!.id,
          output_index: index,
          content_index: 0,
          delta: piece,
          logprobs: [],
        }),
      ];
    },
    fail: (message) => [
      ...close(),
      event({ type: "error", code: "server_error", message, param: null }),
    ],
    finish: (calls, usage) => [
      ...close(),
      ...calls.flatMap((call) => {
        index += 1;
        const args = JSON.stringify(call.input);
        const item = {
          type: "function_call",
          id: idOf("fc_"),
          call_id: idOf("call_"),
          name: call.toolName,
        };
        output.push({ ...item, arguments: args, status: "completed" });
        return [
          event({
            type: "response.output_item.added",
            output_index: index,
            item: { ...item, arguments: "", status: "in_progress" },
          }),
          event({
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: index,
            delta: args,
          }),
          event({
            type: "response.output_item.done",
            output_index: index,
            item: { ...item, arguments: args, status: "completed" },
          }),
        ];
      }),
      event({
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output,
          incomplete_details: null,
          usage: {
            input_tokens: usage.inputTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: usage.outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        },
      }),
    ],
  };
}

const TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "invalid_api_key",
  403: "permission_denied",
  404: "model_not_found",
  429: "rate_limit_exceeded",
};

export const openaiResponses: Protocol = {
  read,
  encoder,
  refusal: (code, message) => ({
    error: { message, type: TYPES[code] ?? "server_error", code: TYPES[code] ?? null, param: null },
  }),
};
