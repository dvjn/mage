// Streams a reply with the AI SDK from a provider's language model, turns the SDK's stream parts
// into our model events, and sorts the provider's failures into our error kinds, with what the
// provider said and the response headers that explain a limit.

import {
  APICallError,
  isStepCount,
  type LanguageModel,
  RetryError,
  type ModelMessage as SdkMessage,
  streamText,
} from "ai";

import {
  type ModelErrorKind,
  type ModelEvent,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@/ports/model-gateway.ts";

type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

// What one provider's error responses carry beyond the status and body.
export interface ProviderErrors {
  // Whether a response header (lower case) helps explain the failure.
  explains(name: string): boolean;
  // When the limit that refused the request resets, from the provider's own headers or body.
  resetsAt?(headers: Record<string, string>, body: unknown, now: Date): Date | null;
}

function sdkMessages(messages: ModelMessage[]): SdkMessage[] {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.text }
      : { role: "assistant", content: [{ type: "text", text: message.text }] },
  );
}

function parseJson(body: string | undefined): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// The provider's own explanation from an error body, when it gives one.
function providerMessage(body: string | undefined, parsed: unknown) {
  if (!body) return undefined;
  const found = ["error", "detail", "message"]
    .map((key) => fieldOf(parsed, key))
    .map((value) => (typeof value === "string" ? value : fieldOf(value, "message")))
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return found ?? body.slice(0, 300);
}

// The error's type or code, as providers name them in error bodies and stream error events.
function errorCode(parsed: unknown) {
  const error = fieldOf(parsed, "error") ?? parsed;
  const code = [fieldOf(error, "type"), fieldOf(error, "code")].find(
    (value): value is string => typeof value === "string",
  );
  return code ?? "";
}

// A Retry-After header in seconds or as an HTTP date.
function retryAfter(headers: Record<string, string>, now: Date) {
  const value = headers["retry-after"];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(now.getTime() + seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

function kindOfStatus(status: number, message: string, code: string): ModelErrorKind | null {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "limit";
  if (status === 404) return "model";
  if ((status === 400 || status === 422) && /model/i.test(`${code} ${message}`)) return "model";
  if (status >= 500) return "network";
  return null;
}

function kindOfCode(code: string): ModelErrorKind | null {
  if (/authentication|permission|unauthori[sz]ed|invalid_api_key/.test(code)) return "auth";
  if (/rate_limit|usage_limit|quota|insufficient/.test(code)) return "limit";
  if (/not_found|model_not/.test(code)) return "model";
  if (/overloaded|server_error|api_error|unavailable|timeout/.test(code)) return "network";
  return null;
}

function headerLines(headers: Record<string, string>, provider: ProviderErrors) {
  return Object.entries(headers)
    .filter(([name]) => name === "retry-after" || provider.explains(name))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}: ${value}`);
}

// Our error for a failure the AI SDK reports.
export function modelErrorOf(error: unknown, provider: ProviderErrors, now = new Date()): Error {
  if (RetryError.isInstance(error)) return modelErrorOf(error.lastError, provider, now);
  if (error instanceof ModelError) return error;
  if (APICallError.isInstance(error)) {
    const headers = Object.fromEntries(
      Object.entries(error.responseHeaders ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    const parsed = parseJson(error.responseBody);
    const status = error.statusCode;
    if (status === undefined) return new ModelError("network", error.message);
    const message = providerMessage(error.responseBody, parsed) ?? "(empty body)";
    const code = errorCode(parsed);
    const detail = [`${status} ${message}`, ...headerLines(headers, provider)].join("\n");
    const kind = kindOfStatus(status, message, code) ?? kindOfCode(code);
    if (!kind) return new Error(`${status} ${message}`, { cause: error });
    const resetsAt =
      kind === "limit"
        ? (provider.resetsAt?.(headers, parsed, now) ?? retryAfter(headers, now))
        : null;
    return new ModelError(kind, detail, resetsAt);
  }
  // An error event inside the stream.
  const code = errorCode(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (providerMessage(JSON.stringify(error), error) ?? "unknown");
  const kind = kindOfCode(code);
  if (kind) return new ModelError(kind, code ? `${code}: ${message}` : message);
  if (error instanceof TypeError) return new ModelError("network", message);
  return new Error(message, { cause: error });
}

export async function* streamReply(
  model: LanguageModel,
  request: ModelRequest,
  signal: AbortSignal,
  options: { system?: string; providerOptions?: ProviderOptions; errors: ProviderErrors },
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
        throw modelErrorOf(part.error, options.errors);
      case "abort":
        throw signal.reason ?? new Error("aborted");
    }
  }
}
