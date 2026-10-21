// Streams a reply with the AI SDK from a provider's language model, and turns the SDK's stream parts
// into our model events.

import {
  APICallError,
  isStepCount,
  type LanguageModel,
  RetryError,
  type ModelMessage as SdkMessage,
  streamText,
} from "ai";

import type { ModelEvent, ModelMessage, ModelRequest } from "@/ports/model-gateway.ts";

type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

function sdkMessages(messages: ModelMessage[]): SdkMessage[] {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.text }
      : { role: "assistant", content: [{ type: "text", text: message.text }] },
  );
}

// The provider's own explanation from an error response body, when it gives one.
function providerMessage(body: string | undefined) {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string };
      detail?: string | { message?: string };
      message?: string;
    };
    const found = [parsed.error, parsed.detail, parsed.message]
      .map((value) => (typeof value === "string" ? value : value?.message))
      .find(Boolean);
    if (found) return found;
  } catch {}
  return body.slice(0, 300);
}

function errorText(error: unknown): string {
  if (RetryError.isInstance(error)) return errorText(error.lastError);
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? `${error.statusCode} ` : "";
    return `${status}${providerMessage(error.responseBody) ?? error.message}`;
  }
  return error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
}

export async function* streamReply(
  model: LanguageModel,
  request: ModelRequest,
  signal: AbortSignal,
  options: { system?: string; providerOptions?: ProviderOptions } = {},
): AsyncIterable<ModelEvent> {
  const result = streamText({
    model,
    ...(options.system !== undefined && { system: options.system }),
    messages: sdkMessages(request.messages),
    ...(options.providerOptions && { providerOptions: options.providerOptions }),
    stopWhen: isStepCount(request.maxSteps),
    // Messages taken in at a step boundary join the conversation before the next step.
    prepareStep: ({ stepNumber, messages }) => {
      if (stepNumber === 0 || !request.beforeStep) return undefined;
      const added = request.beforeStep();
      return added.length > 0 ? { messages: [...messages, ...sdkMessages(added)] } : undefined;
    },
    abortSignal: signal,
    // Failures arrive as stream parts and are thrown below.
    onError: () => {},
  });
  for await (const part of result.stream) {
    switch (part.type) {
      case "start-step":
        yield { type: "step-start" };
        break;
      case "text-delta":
        if (part.text) yield { type: "delta", text: part.text };
        break;
      case "finish-step":
        yield {
          type: "step-end",
          usage: {
            inputTokens: part.usage.inputTokens ?? 0,
            outputTokens: part.usage.outputTokens ?? 0,
          },
        };
        break;
      case "error":
        throw new Error(errorText(part.error), { cause: part.error });
      case "abort":
        throw signal.reason ?? new Error("aborted");
    }
  }
}
