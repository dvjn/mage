// What can be done from a transcript row.

import { type AskAnswers } from "@/shared/ask.ts";
import type { ToolScope } from "@/shared/threads/events.ts";
import type { ShownRow } from "@/shared/threads/rows.ts";

// What can be done from a row: try its run again, open the model picker, decide on a tool call
// for those who may, or send one's own message again changed.
export interface RowActions {
  retry?: () => void;
  pickModel?: () => void;
  decide?: (allow: boolean, scope: ToolScope) => Promise<void>;
  // Answers the questions a call asks, or with null skips them.
  answer?: (answers: AskAnswers | null) => Promise<void>;
  edit?: (text: string) => Promise<void>;
}

// What a page does for its rows' actions; each is called with the row's own ids.
export interface RowActionHandlers {
  retry: (runId: string) => void;
  // Set where the reader may pick the thread's model.
  pickModel?: () => void;
  decide: (callId: string, allow: boolean, scope: ToolScope) => Promise<void>;
  answer: (callId: string, answers: AskAnswers | null) => Promise<void>;
  edit: (rowId: string, text: string) => Promise<void>;
}

// The actions of a row, the same object for the same row for as long as the handlers are the same,
// so a row whose data has not changed is not rendered again for a new event of the thread.
export function rowActions(handlers: RowActionHandlers): (row: ShownRow) => RowActions {
  const made = new WeakMap<ShownRow, RowActions>();
  return (row) => {
    const known = made.get(row);
    if (known) return known;
    const actions: RowActions = {
      ...((row.kind === "failure" || row.kind === "stop") &&
        row.canRetry && { retry: () => handlers.retry(row.runId) }),
      ...(handlers.pickModel && { pickModel: handlers.pickModel }),
      ...(row.kind === "tool" &&
        !!row.actions?.length && {
          decide: (allow: boolean, scope: ToolScope) => handlers.decide(row.id, allow, scope),
        }),
      ...(row.kind === "tool" &&
        row.canAnswer && {
          answer: (answers: AskAnswers | null) => handlers.answer(row.id, answers),
        }),
      ...(row.kind === "human" &&
        row.can?.includes("edit") && { edit: (text: string) => handlers.edit(row.id, text) }),
    };
    made.set(row, actions);
    return actions;
  };
}
