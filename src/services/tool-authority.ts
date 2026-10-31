// Who may use a tool without approval, who may approve a call, and whether a call runs now or
// waits. A person's level comes from how they reach the thread now: anyone who can message in it
// may use tools and approve calls, anyone else may do neither. The rules that apply to a tool
// (the org's policy, and a space's extra rule) narrow that: a person uses it directly only when
// every rule lets them, and approves only when every rule that asks for approval names them, or
// anyone who can edit the thread when none asks. Where independence applies, the approver can't
// be the author of the thread's latest human message. A call runs at once when the tool declares
// normal risk, no rule makes every call ask, and everyone whose words the model read may use it
// directly; or on a standing approval that still holds. Otherwise it waits. A call that asks the
// thread questions always waits for an answer, which anyone who may use or approve the tool gives;
// an answer counts as its writer's words like a message.

import type { ToolLevel } from "@/ports/tools.ts";
import type { Access } from "@/services/thread-access.ts";
import type { ToolRisk } from "@/shared/threads.ts";
import { EDITORS, type PolicyUse } from "@/shared/tools.ts";

// Anyone who can message in the thread may use its tools: its space's owners and messagers, and
// its guests, who may always post there. Viewers, and anyone with no access any more, may not.
export function levelOf(access: Access | null): ToolLevel {
  if (!access) return "approve";
  if (access.via === "guest") return "run";
  return access.role === "viewer" ? "approve" : "run";
}

// What a policy says: who uses its tools without approval, and who approves everyone else, by key.
export interface Rule {
  use: PolicyUse;
  users: readonly string[];
  approvers: readonly string[];
  independent: boolean;
}

// What applies to a tool with nothing set: anyone uses it.
export const OPEN: Rule = { use: "everyone", users: [], approvers: [], independent: false };

// What applies in place of a policy that is gone: nobody uses it, and nobody approves.
export const NOBODY: Rule = { use: "none", users: [], approvers: [], independent: false };

// A person as rules see them in one thread: their level there, and the keys they answer to:
// their own, those of the linked groups they are active in, and anyone who can edit the thread.
export interface Person {
  userId: string;
  level: ToolLevel;
  keys: ReadonlySet<string>;
}

export function personOf(userId: string, level: ToolLevel, groupIds: readonly string[]): Person {
  const keys = new Set([`user:${userId}`, ...groupIds.map((id) => `group:${id}`)]);
  if (level === "run") keys.add(EDITORS);
  return { userId, level, keys };
}

function names(person: Person, keys: readonly string[]) {
  return keys.some((key) => person.keys.has(key));
}

// Whether the person may use the tool without approval under every rule.
export function canUse(person: Person, rules: readonly Rule[]) {
  return (
    person.level === "run" &&
    rules.every(
      (rule) => rule.use === "everyone" || (rule.use === "some" && names(person, rule.users)),
    )
  );
}

// How much a call needs: the tool's own risk, raised to asking each time where a rule lets no one
// use it directly, and to independent review where a rule asks for independence.
export function riskOf(declared: ToolRisk, rules: readonly Rule[]): ToolRisk {
  if (declared === "review" || rules.some((rule) => rule.use !== "everyone" && rule.independent)) {
    return "review";
  }
  if (declared === "ask" || rules.some((rule) => rule.use === "none")) return "ask";
  return "normal";
}

// A row of the thread as rules read it: a person's message, or a call someone answered.
export interface WordsRow {
  kind: string;
  seq: number;
  author?: { userId: string };
  answers?: unknown;
  decision?: { by: { userId: string }; seq: number } | null;
}

// The people's words the model read, where each sits in the thread and who wrote it: their
// messages, and their answers to the agent's questions.
export function wordsIn(rows: readonly WordsRow[]) {
  const words: { seq: number; userId: string }[] = [];
  for (const row of rows) {
    if (row.kind === "human" && row.author) words.push({ seq: row.seq, userId: row.author.userId });
    else if (row.kind === "tool" && row.answers && row.decision) {
      words.push({ seq: row.decision.seq, userId: row.decision.by.userId });
    }
  }
  return words.sort((a, b) => a.seq - b.seq);
}

// Who wrote the thread's latest words: a message, or an answer.
export function latestAuthor(rows: readonly WordsRow[]) {
  return wordsIn(rows).at(-1)?.userId ?? null;
}

// Whether the person may approve a call with this risk under the rules: they can edit the thread,
// every rule that asks for approval names them, and under review they did not write last.
export function mayApprove(
  person: Person,
  rules: readonly Rule[],
  risk: ToolRisk,
  latest: string | null,
) {
  if (person.level !== "run") return false;
  const asking = rules.filter((rule) => rule.use !== "everyone");
  if (!asking.every((rule) => names(person, rule.approvers))) return false;
  return risk !== "review" || latest !== person.userId;
}

// Whether the person may answer a call's questions: they may use the tool directly, or approve the
// call; an answer stands for both.
export function mayAnswer(
  person: Person,
  rules: readonly Rule[],
  risk: ToolRisk,
  latest: string | null,
) {
  return canUse(person, rules) || mayApprove(person, rules, risk, latest);
}

// A person's words the model read: where they sit in the thread, their writer's level now, and
// whether they may use the tool directly.
export interface Influence {
  seq: number;
  level: ToolLevel;
  canUse: boolean;
}

// An approval: where it was given, and whether its giver may still approve.
export interface Approval {
  atSeq: number;
  eligible: boolean;
}

// Whether a standing approval still holds: its giver may still approve, and everyone who wrote
// after it may use the tool directly.
export function holds(approval: Approval, influence: readonly Influence[]) {
  return (
    approval.eligible && influence.every((words) => words.seq <= approval.atSeq || words.canUse)
  );
}

// Whether an approval of one call still holds just before it runs: its giver may still approve,
// and everyone who wrote after it can still message in the thread.
export function holdsOnce(approval: Approval, influence: readonly Influence[]) {
  return (
    approval.eligible &&
    influence.every((words) => words.seq <= approval.atSeq || words.level === "run")
  );
}

// Whether a call runs as its people may, runs on a standing approval, or waits for a decision.
export function decide(input: {
  declared: ToolRisk;
  rules: readonly Rule[];
  influence: readonly Influence[];
  standing: readonly Approval[];
}): "run" | "standing" | "wait" {
  const { declared, rules, influence, standing } = input;
  if (declared !== "normal" || rules.some((rule) => rule.use === "none")) return "wait";
  if (influence.every((words) => words.canUse)) return "run";
  if (
    riskOf(declared, rules) === "normal" &&
    standing.some((approval) => holds(approval, influence))
  ) {
    return "standing";
  }
  return "wait";
}
