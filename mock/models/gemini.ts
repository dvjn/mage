// The stand-in model as the Gemini API's streamGenerateContent, as Vertex AI speaks it too: each
// chunk a candidate with the parts it adds, its thoughts marked as such, function calls whole, and
// the finish reason with the usage last.

import {
  conversationBuilder,
  type Conversation,
  type Encoder,
  type Protocol,
  textOf,
} from "./wire.ts";

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response?: unknown };
}

interface GenerateRequest {
  contents?: { role?: string; parts?: Part[] }[];
  systemInstruction?: { parts?: Part[] };
  tools?: { functionDeclarations?: { name?: string }[] }[];
}

// What a function response carries, as the AI SDK sends it: the output under `content`.
function responseOf(response: unknown) {
  const content = (response as { content?: unknown } | undefined)?.content;
  return content === undefined ? response : content;
}

function read(body: unknown, model: string): Conversation {
  const request = (body ?? {}) as GenerateRequest;
  const conversation = conversationBuilder();
  for (const content of request.contents ?? []) {
    const parts = content.parts ?? [];
    const text = parts
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("");
    if (content.role === "model") {
      conversation.assistant(
        text,
        parts.flatMap((part, index) =>
          part.functionCall
            ? [
                {
                  id: `${part.functionCall.name}#${index}`,
                  name: part.functionCall.name,
                  input: part.functionCall.args ?? {},
                },
              ]
            : [],
        ),
      );
      continue;
    }
    for (const part of parts) {
      if (!part.functionResponse) continue;
      const { name, response } = part.functionResponse;
      conversation.result(name, responseOf(response), false, name);
    }
    conversation.user(text);
  }
  return {
    model,
    instructions: textOf(request.systemInstruction?.parts),
    messages: conversation.messages,
    tools: (request.tools ?? []).flatMap((tool) =>
      (tool.functionDeclarations ?? []).flatMap((declared) => declared.name ?? []),
    ),
  };
}

function encoder(): Encoder {
  const chunk = (parts: Part[], extra: object = {}) => ({
    data: { candidates: [{ content: { role: "model", parts }, index: 0, ...extra }] },
  });
  return {
    start: () => [],
    reasoning: (piece) => [chunk([{ text: piece, thought: true }])],
    text: (piece) => [chunk([{ text: piece }])],
    finish: (calls, usage) => [
      {
        data: {
          ...chunk(
            calls.map((call) => ({ functionCall: { name: call.toolName, args: call.input } })),
            { finishReason: "STOP" },
          ).data,
          usageMetadata: {
            promptTokenCount: usage.inputTokens,
            candidatesTokenCount: usage.outputTokens,
            totalTokenCount: usage.inputTokens + usage.outputTokens,
          },
        },
      },
    ],
  };
}

const STATUSES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  503: "UNAVAILABLE",
};

// The model is named in the path, not the body.
export function gemini(model: string): Protocol {
  return {
    read: (body) => read(body, model),
    encoder,
    refusal: (code, message) => ({
      error: { code, message, status: STATUSES[code] ?? "INTERNAL" },
    }),
  };
}
