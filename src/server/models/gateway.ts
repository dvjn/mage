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

// What a connection reaches its host with: an access token or key (empty with none), the account
// it is for, its proxy, and, for the hosts that need them, its settings and its other secrets.
export interface ModelToken {
  access: string;
  accountId: string | null;
  proxy?: ProviderProxy | null;
  settings?: Record<string, string>;
  secrets?: Record<string, string>;
}

// A tool the model may call, with its input as a JSON schema.
export interface ModelTool {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// A call the model asked for; `input` is whatever it sent, checked later.
export interface ModelToolCall {
  callId: string;
  toolId: string;
  input: unknown;
}

// What a call gave back to the model.
export interface ModelToolResult {
  callId: string;
  toolId: string;
  output: { ok: true; value: unknown } | { ok: false; error: string };
}

// What changed in the thread at a point in its conversation, for a provider that takes it there
// rather than in the request's start: the searchable tools turned on, and the effort replies are
// asked for from there.
export interface ModelChange {
  tools?: string[];
  effort?: Effort;
}

// A person's words, the model's answer with the calls it asked for, what those calls gave back, or
// what changed at that point.
export type ModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; results: ModelToolResult[] }
  | ({ role: "change" } & ModelChange);

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
  // The effort the thread's first reply was asked for. A provider that takes effort changes in the
  // conversation keeps it as the request's own, and the changes since say what holds now.
  firstEffort?: Effort;
  // Called at each step boundary after the first; the messages it returns join the conversation
  // before the next step.
  beforeStep?: () => ModelMessage[];
  // The tools the model may call. A step that calls any ends the request; whoever asked runs them
  // and asks again with what they gave back.
  tools?: ModelTool[];
  // The tools the model may turn on by searching for them, in a fixed order, and those it turned
  // on in the thread, in the order it did. A provider that can declare tools left out until turned
  // on declares them all and turns them on where the conversation's changes say; any other is sent
  // those turned on after `tools`.
  searchable?: ModelTool[];
  toolsOn?: string[];
}

export type ModelEvent =
  | { type: "step-start" }
  | { type: "delta"; text: string }
  // A piece of the model's reasoning, or of the provider's summary of it, before its answer.
  | { type: "reasoning"; text: string }
  // A tool call the step asks for; it comes before the step's end.
  | ({ type: "tool-call" } & ModelToolCall)
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
  // What people are told, where the kind's usual words would not say why.
  readonly summary: string | null;

  constructor(
    kind: ModelErrorKind,
    detail: string,
    resetsAt: Date | null = null,
    summary: string | null = null,
  ) {
    super(detail);
    this.kind = kind;
    this.detail = detail;
    this.resetsAt = resetsAt;
    this.summary = summary;
  }
}

// The model is one its org turned off.
export class ModelTurnedOff extends ModelError {
  constructor(name: string) {
    const said = `Model ${name} is turned off. Choose another model to continue.`;
    super("model", said, null, said);
  }
}
