// Streams a reply with the AI SDK from a provider's language model, turns the SDK's stream parts
// into our model events, and sorts the provider's failures into our error kinds, with what the
// provider said and the response headers that explain a limit. Tools go to the model without a way
// to run them, so a step that calls any ends the request with its calls; their ids become names
// providers accept, and back. Tools go in the order given. What changed in the thread at a point in
// its conversation goes there as a system message to a provider that takes it so, and otherwise
// into the request's own settings.

import {
  APICallError,
  isStepCount,
  jsonSchema,
  type Instructions,
  type JSONSchema7,
  type LanguageModel,
  RetryError,
  type ModelMessage as SdkMessage,
  streamText,
  type ToolSet,
} from "ai";

import { modelTelemetry } from "@/server/kernel/tracing.ts";
import { wireToolName } from "@/shared/tools.ts";
import {
  type ModelChange,
  type ModelErrorKind,
  type ModelEvent,
  ModelError,
  type ModelMessage,
  type ModelRequest,
} from "@/server/models/gateway.ts";

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

// How a provider takes what changed in a thread inside its conversation, so that the request's
// start stays as it was: each change as an empty system message, and, for one that turns tools on
// so, the searchable tools all declared from the first request, each left out until turned on.
export interface InlineChanges {
  // What declares a tool left out until a change turns it on.
  deferred?: ProviderOptions;
  // The options of the system message that tells the change, its tools by their names for the
  // provider; null for a change it does not take so.
  message(change: ModelChange): ProviderOptions | null;
}

// What one provider's error responses carry beyond the status and body.
export interface ProviderErrors {
  // Whether a response header (lower case) helps explain the failure.
  explains(name: string): boolean;
  // When the limit that refused the request resets, from the provider's own headers or body.
  resetsAt?(headers: Record<string, string>, body: unknown, now: Date): Date | null;
}

// A tool's name for the model as a function name providers accept.
export function toolName(id: string) {
  return wireToolName(id);
}

// Changes next to each other, told as one.
function joined(messages: ModelMessage[]) {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (message.role === "change" && last?.role === "change") {
      const tools = [...(last.tools ?? []), ...(message.tools ?? [])];
      const effort = message.effort ?? last.effort;
      out[out.length - 1] = {
        role: "change",
        ...(tools.length > 0 && { tools }),
        ...(effort && { effort }),
      };
    } else {
      out.push(message);
    }
  }
  return out;
}

// The messages as the AI SDK takes them; changes only for a provider that takes them inline.
function sdkMessages(messages: ModelMessage[], changes?: InlineChanges): SdkMessage[] {
  return joined(messages).flatMap((message): SdkMessage[] => {
    switch (message.role) {
      case "change": {
        if (!changes) return [];
        const { role: _role, tools, ...change } = message;
        const providerOptions = changes.message({
          ...change,
          ...(tools && { tools: tools.map(toolName) }),
        });
        return providerOptions ? [{ role: "system", content: "", providerOptions }] : [];
      }
      case "user":
        return [{ role: "user", content: message.text }];
      case "assistant": {
        const calls = (message.toolCalls ?? []).map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.callId,
          toolName: toolName(call.toolId),
          input: call.input,
        }));
        const text = message.text ? [{ type: "text" as const, text: message.text }] : [];
        return [{ role: "assistant", content: [...text, ...calls] }];
      }
      case "tool": {
        const results = message.results.map((result) => ({
          type: "tool-result" as const,
          toolCallId: result.callId,
          toolName: toolName(result.toolId),
          output: result.output.ok
            ? { type: "json" as const, value: (result.output.value ?? null) as never }
            : { type: "error-text" as const, value: result.output.error },
        }));
        return [{ role: "tool", content: results }];
      }
    }
  });
}

// The tools sent, in order: `tools`, then, for a provider that turns tools on in the conversation,
// every searchable tool, left out until turned on, and for any other those turned on.
function toolsSent(request: ModelRequest, changes?: InlineChanges) {
  const searchable = request.searchable ?? [];
  const tools = (request.tools ?? []).map((tool) => ({ tool, providerOptions: undefined }));
  const deferred = changes?.deferred;
  if (deferred) {
    return [...tools, ...searchable.map((tool) => ({ tool, providerOptions: deferred }))];
  }
  const byId = new Map(searchable.map((tool) => [tool.id, tool]));
  const on = (request.toolsOn ?? []).flatMap((id) => byId.get(id) ?? []);
  return [...tools, ...on.map((tool) => ({ tool, providerOptions: undefined }))];
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

// A refusal on policy grounds, which a provider may send as a 403 though the sign-in works.
const POLICY_REFUSAL = /polic(y|ies)|terms of (use|service)|safety/i;

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
    const refused = status === 403 && POLICY_REFUSAL.test(message);
    const kind = refused ? null : (kindOfStatus(status, message, code) ?? kindOfCode(code));
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
  options: {
    // The system prompt, or its blocks in order.
    system?: Instructions;
    // The AI SDK's own reasoning setting, which the provider turns into its own.
    reasoning?: ModelRequest["effort"];
    providerOptions?: ProviderOptions;
    errors: ProviderErrors;
    // For a provider that takes what changed in the thread inside its conversation, how.
    changes?: InlineChanges;
  },
): AsyncIterable<ModelEvent> {
  const { changes } = options;
  const sent = toolsSent(request, changes);
  // The tools by the names the model knows them by.
  const ids = new Map(sent.map(({ tool }) => [toolName(tool.id), tool.id]));
  const tools: ToolSet = Object.fromEntries(
    sent.map(({ tool, providerOptions }) => [
      toolName(tool.id),
      {
        description: tool.description,
        inputSchema: jsonSchema(tool.inputSchema as JSONSchema7),
        ...(providerOptions && { providerOptions }),
      },
    ]),
  );
  const result = streamText({
    model,
    ...(options.system !== undefined && { system: options.system }),
    ...(options.reasoning && { reasoning: options.reasoning }),
    messages: sdkMessages(request.messages, changes),
    ...(changes && { allowSystemInMessages: true }),
    ...(options.providerOptions && { providerOptions: options.providerOptions }),
    // Sent in the order given.
    ...(ids.size > 0 && { tools, toolOrder: [...ids.keys()] }),
    // A step with tool calls ends the request: the calls run elsewhere.
    stopWhen: [
      isStepCount(request.maxSteps),
      ({ steps }) => (steps.at(-1)?.toolCalls.length ?? 0) > 0,
    ],
    // Messages taken in at a step boundary join the conversation before the next step.
    prepareStep: ({ stepNumber, messages }) => {
      if (stepNumber === 0 || !request.beforeStep) return undefined;
      const added = request.beforeStep();
      return added.length > 0
        ? { messages: [...messages, ...sdkMessages(added, changes)] }
        : undefined;
    },
    abortSignal: signal,
    // Traced when tracing is on, with the whole prompt and reply only when content is recorded.
    telemetry: modelTelemetry(),
    // Failures arrive as stream parts and are thrown below.
    onError: () => {},
  });
  // Whether the step has reasoning yet, so that each further reasoning part starts a paragraph.
  let reasoned = false;
  let reasoningStarts = false;
  for await (const part of result.stream) {
    switch (part.type) {
      case "start-step":
        reasoned = false;
        yield { type: "step-start" };
        break;
      case "reasoning-start":
        reasoningStarts = reasoned;
        break;
      case "reasoning-delta":
        if (!part.text) break;
        yield { type: "reasoning", text: reasoningStarts ? `\n\n${part.text}` : part.text };
        reasoned = true;
        reasoningStarts = false;
        break;
      case "text-delta":
        if (part.text) yield { type: "delta", text: part.text };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          callId: part.toolCallId,
          toolId: ids.get(part.toolName) ?? part.toolName,
          input: part.input,
        };
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
