// What can be done from a transcript row.

import { type AskAnswers } from "@/shared/ask.ts";
import type { ToolScope } from "@/shared/threads/events.ts";

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
