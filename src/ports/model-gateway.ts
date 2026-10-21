// Streams a model's reply from a provider, as our own events.

export interface ModelToken {
  access: string;
  accountId: string | null;
}

export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelRequest {
  // The provider's model id.
  model: string;
  instructions: string;
  messages: ModelMessage[];
  // The most model steps this request may take.
  maxSteps: number;
  // Keeps one thread's requests together on the provider's side.
  sessionId: string;
  // Called at each step boundary after the first; the messages it returns join the conversation
  // before the next step.
  beforeStep?: () => ModelMessage[];
}

export type ModelEvent =
  | { type: "step-start" }
  | { type: "delta"; text: string }
  | { type: "step-end"; usage: ModelUsage };

export interface ModelGateway {
  // Ends when the reply is done; throws when the provider fails or the signal aborts.
  stream(token: ModelToken, request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
