// The model-facing wording of a failed run: sentences composed from its kind and raw message, which
// people read as the UI's own wording instead.

import { parseModelRef } from "@/shared/model-ref.ts";
import type { FailureKind } from "@/shared/threads/events.ts";

export const CONNECTION_LABELS = { codex: "Codex", claude: "Claude" } as const;

export type ConnectionKind = keyof typeof CONNECTION_LABELS;

export function connectionOf(ref: string): ConnectionKind | undefined {
  const { connectionId } = parseModelRef(ref);
  return Object.hasOwn(CONNECTION_LABELS, connectionId)
    ? (connectionId as ConnectionKind)
    : undefined;
}

const KIND_MESSAGES: Record<"auth" | "limit" | "model" | "network", (label: string) => string> = {
  auth: (label) => `The ${label} sign-in no longer works. Reconnect it in Model providers.`,
  limit: (label) => `${label} limit reached.`,
  model: (label) => `${label} cannot use this model. Pick another model.`,
  network: (label) => `Couldn't reach ${label}.`,
};

// The sentence for a failure: what the provider said when it said something, else one for its kind.
export function failureSentence(failure: {
  error?: string;
  kind?: FailureKind;
  connection?: ConnectionKind;
}): string {
  const { error, kind, connection } = failure;
  switch (kind) {
    case "no_model":
      return "Pick a model for this thread.";
    case "gone":
      return "The thread is gone.";
    case "interrupted":
      return "The server stopped while the agent was replying.";
    case "gave_up":
      return "The agent stopped too many times on this input and gave up.";
    case "model_error":
      return `The model failed: ${error}`;
    case undefined:
      return error || "The agent could not reply.";
    default:
      return (
        error || KIND_MESSAGES[kind](connection ? CONNECTION_LABELS[connection] : "The provider")
      );
  }
}
