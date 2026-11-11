// A run that failed: why, in words for its kind, and what to do about it.

import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

import type { FailureRow } from "@/shared/threads/rows.ts";
import { Button } from "@/web/components/ui/button";
import { useMinute } from "@/web/hooks/use-minute";
import { timeUntil } from "@/web/lib/time";
import { CONNECTION_LABELS } from "@/web/models/model-picker";
import { RetryButton } from "@/web/threads/transcript/retry-button";
import type { RowActions } from "@/web/threads/transcript/row-actions";

// Why the run failed, in words for its kind, with the step that helps and what the provider said.
export function FailureNotice({ row, actions }: { row: FailureRow; actions: RowActions }) {
  // When a limit resets is said relative to now.
  useMinute();
  const label = row.connection ? CONNECTION_LABELS[row.connection] : "the provider";
  let summary: ReactNode = "The agent stopped.";
  let step: ReactNode = null;
  switch (row.failure) {
    case "auth":
      summary = `${label === "the provider" ? "The provider" : `The ${label}`} sign-in no longer works.`;
      step = (
        <Button
          size="xs"
          variant="outline"
          render={<Link to="/org/providers" />}
          nativeButton={false}
        >
          Reconnect {label}
        </Button>
      );
      break;
    case "limit": {
      const resets = row.resetsAt && timeUntil(row.resetsAt);
      summary = resets ? `Limit reached, resets ${resets}.` : "Limit reached.";
      break;
    }
    case "no_model":
      summary = "No model is picked for this thread.";
      if (actions.pickModel) {
        step = (
          <Button size="xs" variant="outline" onClick={actions.pickModel}>
            Pick a model
          </Button>
        );
      }
      break;
    case "gone":
      summary = "The thread is gone.";
      break;
    case "interrupted":
      summary = "The server stopped while the agent was replying.";
      break;
    case "gave_up":
      summary = "The agent stopped repeatedly on this message and gave up.";
      break;
    case "model_error":
      summary = "The model failed.";
      break;
    case "model":
      summary = `${label === "the provider" ? "The provider" : label} cannot use this model.`;
      if (actions.pickModel) {
        step = (
          <Button size="xs" variant="outline" onClick={actions.pickModel}>
            Pick another model
          </Button>
        );
      }
      break;
    case "network":
      summary = `Couldn't reach ${label}.`;
      break;
  }
  // What the provider or system said is shown for the kinds with no steps of their own to read it by.
  const shownError = row.failure === undefined || row.failure === "model_error" ? row.error : "";
  return (
    <div
      role="status"
      aria-label="Run failed"
      className="flex flex-col gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto">{summary}</span>
        {step}
        {actions.retry && <RetryButton onRetry={actions.retry} />}
      </div>
      {(row.detail || shownError) && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none">Details</summary>
          <pre className="mt-1 font-mono break-words whitespace-pre-wrap">
            {[shownError, row.detail].filter(Boolean).join("\n\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
