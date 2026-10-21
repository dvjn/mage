// Streams a model's reply from a provider, as our own events, and says why when the provider
// refuses: the sign-in no longer works, a limit was reached, the model is not available, or the
// provider could not be reached.

// Where a connection's provider API requests go instead of the provider's own API, and the
// headers they carry besides ours. Signing in and renewing tokens never go through it.
export interface ProviderProxy {
  // Replaces the provider's API base; null keeps it.
  baseUrl: string | null;
  headers: Record<string, string>;
}

export interface ModelToken {
  access: string;
  accountId: string | null;
  proxy?: ProviderProxy | null;
}

export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

// How hard a model that can think does so before it answers.
export type Effort = "low" | "medium" | "high";

export interface ModelRequest {
  // The provider's model id.
  model: string;
  instructions: string;
  messages: ModelMessage[];
  // The most model steps this request may take.
  maxSteps: number;
  // Keeps one thread's requests together on the provider's side.
  sessionId: string;
  // Set only for a model that can think; it then streams its reasoning too.
  effort?: Effort;
  // Called at each step boundary after the first; the messages it returns join the conversation
  // before the next step.
  beforeStep?: () => ModelMessage[];
}

export type ModelEvent =
  | { type: "step-start" }
  | { type: "delta"; text: string }
  // A piece of the model's reasoning, or of the provider's summary of it, before its answer.
  | { type: "reasoning"; text: string }
  | { type: "step-end"; usage: ModelUsage };

export interface ModelGateway {
  // Ends when the reply is done; throws when the provider fails or the signal aborts.
  stream(token: ModelToken, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export type ModelErrorKind = "auth" | "limit" | "model" | "network";

// A provider failure sorted by what people can do about it. `detail` is what the provider said,
// with the response headers that explain it.
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly detail: string;
  // When a limit resets, when the provider says.
  readonly resetsAt: Date | null;

  constructor(kind: ModelErrorKind, detail: string, resetsAt: Date | null = null) {
    super(detail);
    this.kind = kind;
    this.detail = detail;
    this.resetsAt = resetsAt;
  }
}
