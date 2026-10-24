// Who may run a tool, and whether a call runs now or waits for a person's approval. A person's level
// for a tool comes from how they reach the thread now: a space owner runs, a messager runs unless
// the space says otherwise, a viewer needs approval, a guest needs approval except to read the
// thread unless the space says otherwise, and someone with no access any more needs approval. A
// call runs at once when it is of normal risk and everyone whose words the model read may run the
// tool, or when a standing approval covers it; otherwise it waits for someone who may run it. An
// approval, standing or for one call, holds while its giver may still run the tool and everyone who
// wrote after it may too.

import type { ToolLevel } from "@/ports/tools.ts";
import type { Access } from "@/services/thread-access.ts";
import type { ToolRisk } from "@/shared/threads.ts";

// A tool readable by guests without approval.
const GUEST_RUNS = new Set(["thread.info"]);

export interface LevelOverrides {
  messager?: ToolLevel | null;
  guest?: ToolLevel | null;
}

export function levelOf(
  access: Access | null,
  toolId: string,
  overrides: LevelOverrides = {},
): ToolLevel {
  if (!access) return "approve";
  if (access.via === "guest") {
    return overrides.guest ?? (GUEST_RUNS.has(toolId) ? "run" : "approve");
  }
  switch (access.role) {
    case "owner":
      return "run";
    case "messager":
      return overrides.messager ?? "run";
    case "viewer":
      return "approve";
  }
}

// A person's words the model read: where they sit in the thread, and their writer's level now.
export interface Influence {
  seq: number;
  level: ToolLevel;
}

// An approval: where it was given, and its giver's level now.
export interface Approval {
  atSeq: number;
  level: ToolLevel;
}

// Whether the approval still holds against everything written after it.
export function holds(approval: Approval, influence: readonly Influence[]) {
  return (
    approval.level === "run" &&
    influence.every((words) => words.seq <= approval.atSeq || words.level === "run")
  );
}

// Whether a call runs as its people allow, runs on a standing approval, or waits for a decision.
export function decide(input: {
  risk: ToolRisk;
  influence: readonly Influence[];
  standing: readonly Approval[];
}): "run" | "standing" | "wait" {
  const { risk, influence, standing } = input;
  if (risk !== "normal") return "wait";
  if (influence.every((words) => words.level === "run")) return "run";
  if (standing.some((approval) => holds(approval, influence))) return "standing";
  return "wait";
}
