// What a tool call says in the transcript, from its tool and input: what the agent wants to do and
// the detail of it, what happened once it ran, and what did not happen when it did not. It names no
// one; who decided is added where it is shown.

import type { ToolRow } from "@/shared/transcript.ts";

export interface ToolCopy {
  ask: string;
  detail: string;
  done: string;
  notDone: string;
}

function field(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

// A field that should be text, as text.
function text(input: unknown, key: string) {
  const value = field(input, key);
  return typeof value === "string" ? value : "";
}

// `modelName` names a model ref as the reader's org lists it.
export function toolCopy(row: ToolRow, modelName: (ref: string) => string): ToolCopy {
  const { input } = row;
  switch (row.toolId) {
    case "thread.info":
      return {
        ask: "Wants to read this thread's details",
        detail: "Its title, folder, model and people",
        done: "Read this thread's details",
        notDone: "Did not read this thread's details",
      };
    case "thread.rename": {
      const title = text(input, "title");
      return {
        ask: "Wants to rename this thread",
        detail: `To "${title}"`,
        done: `Renamed to "${title}"`,
        notDone: "Not renamed",
      };
    }
    case "thread.move": {
      const folder = field(input, "folder");
      const named = typeof folder === "string" ? folder : null;
      return {
        ask: "Wants to move this thread",
        detail: named ? `To folder: ${named}` : "Out of its folder",
        done: named ? `Moved to ${named}` : "Moved out of its folder",
        notDone: "Not moved",
      };
    }
    case "thread.set_model": {
      const ref = text(input, "model");
      const effort = field(input, "effort");
      const pair = `${modelName(ref)}${typeof effort === "string" ? ` · ${effort}` : ""}`;
      return {
        ask: "Wants to change this thread's model",
        detail: `To ${pair}${row.risk === "ask" ? " (another provider)" : ""}`,
        done: `Set model to ${pair}`,
        notDone: "Model not changed",
      };
    }
    default:
      return {
        ask: `Wants to use ${row.toolId}`,
        detail: JSON.stringify(input),
        done: `Used ${row.toolId}`,
        notDone: `Did not use ${row.toolId}`,
      };
  }
}
