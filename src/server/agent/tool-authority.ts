// Whether a tool call runs on its own, runs on a vouch, or waits. A call runs on its own when
// everyone whose words steered it (the people whose messages, and answers to the agent's
// questions, the model read) could have run the tool themselves. Otherwise an approver vouches
// for it, once or for now; a vouch lasts only while the thread does not change under it. The
// tool's rule sets how strict this is: normally as above; asking, where the tool or a rule that
// lets nobody use it makes every call wait; or reviewing, where every call waits, is allowed once
// at a time, and the approver cannot be the latest writer. Independence, which a rule asks for
// on sensitive actions, holds back even the tool's own users. A tool whose calls go with one
// person's own login asks one more question, whose: a call runs on its own only when one
// connected person wrote everything, and then as them; an approved call runs as its approver; and
// a vouch for now ends when anyone else writes or the giver's login breaks. A question to the
// thread always waits for an answer, and the answer counts as its writer's words. Agents never
// count themselves: a message from another agent counts as the words of everyone who steered it.

import type { Access } from "@/server/spaces/thread-access.ts";
import type { ToolRisk } from "@/shared/threads/events.ts";
import { EDITORS, type PolicyUse } from "@/shared/tools.ts";

// Anyone who can message in the thread may use its tools and approve calls: its space's owners
// and messagers, and its guests whose role is to message. Viewers, guests who only view, and anyone
// with no access any more, may do neither.
export function canPostIn(access: Access | null): boolean {
  if (!access) return false;
  return access.via === "guest" ? access.role === "message" : access.role !== "viewer";
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

// The one rule a tool is used under in a space, from the org's policy and the space's extra rule.
// Each list of keys must name a person for them to count: a user uses the tool directly only when
// every rule that limits its users names them, and approves only when every rule that asks for
// approval names them, so the lists are kept apart rather than merged, since keys name groups as
// well as people. No list at all means anyone who can post.
export interface ToolRule {
  use: PolicyUse;
  users: readonly (readonly string[])[];
  approvers: readonly (readonly string[])[];
  independent: boolean;
}

export function ruleFor(rules: readonly Rule[]): ToolRule {
  const asking = rules.filter((rule) => rule.use !== "everyone");
  return {
    use: rules.some((rule) => rule.use === "none")
      ? "none"
      : asking.length > 0
        ? "some"
        : "everyone",
    users: rules.filter((rule) => rule.use === "some").map((rule) => rule.users),
    approvers: asking.map((rule) => rule.approvers),
    independent: asking.some((rule) => rule.independent),
  };
}

// A person as the rule sees them in one thread: whether they can post there, and the keys they
// answer to: their own, and those of the linked groups they are active in.
export interface Person {
  userId: string;
  canPost: boolean;
  keys: ReadonlySet<string>;
}

export function personOf(userId: string, canPost: boolean, groupIds: readonly string[]): Person {
  const keys = new Set([`user:${userId}`, ...groupIds.map((id) => `group:${id}`)]);
  return { userId, canPost, keys };
}

// Whether a list of keys names the person; `editors` names anyone who can post.
function names(person: Person, keys: readonly string[]) {
  return keys.some((key) => (key === EDITORS ? person.canPost : person.keys.has(key)));
}

// Whether the person may use the tool without approval.
export function canUse(person: Person, rule: ToolRule) {
  return person.canPost && rule.use !== "none" && rule.users.every((keys) => names(person, keys));
}

// How strict the tool is: as it declares, raised to review where a rule asks for independence,
// and to asking where the rule lets nobody use it.
export function riskOf(declared: ToolRisk, rule: ToolRule): ToolRisk {
  if (declared === "review" || rule.independent) return "review";
  if (declared === "ask" || rule.use === "none") return "ask";
  return "normal";
}

// A row of the thread as the rule reads it: a person's message, a call someone answered, or
// another agent's message and the people who steered it.
export interface WordsRow {
  kind: string;
  seq: number;
  author?: { userId: string };
  answers?: unknown;
  decision?: { by: { userId: string }; seq: number } | null;
  steeredBy?: readonly { userId: string }[];
}

// The people's words the model read, where each sits in the thread and who wrote it: their
// messages, their answers to the agent's questions, and the other agents' messages they steered.
export function wordsIn(rows: readonly WordsRow[]) {
  const words: { seq: number; userId: string }[] = [];
  for (const row of rows) {
    if (row.kind === "human" && row.author) words.push({ seq: row.seq, userId: row.author.userId });
    else if (row.kind === "relay") {
      for (const userId of new Set(row.steeredBy?.map((steering) => steering.userId))) {
        words.push({ seq: row.seq, userId });
      }
    } else if (row.kind === "tool" && row.answers && row.decision) {
      words.push({ seq: row.decision.seq, userId: row.decision.by.userId });
    }
  }
  return words.sort((a, b) => a.seq - b.seq);
}

// Who wrote the thread's latest words: a message, or an answer.
export function latestAuthor(rows: readonly WordsRow[]) {
  return wordsIn(rows).at(-1)?.userId ?? null;
}

// Whether the person may approve a call of this strictness: they can post, every rule that asks
// for approval names them, and under review they did not write last.
export function mayApprove(person: Person, rule: ToolRule, risk: ToolRisk, latest: string | null) {
  if (!person.canPost) return false;
  if (!rule.approvers.every((keys) => names(person, keys))) return false;
  return risk !== "review" || latest !== person.userId;
}

// Whether the person may answer a call's questions: they may use the tool directly, or approve the
// call; an answer stands for both.
export function mayAnswer(person: Person, rule: ToolRule, risk: ToolRisk, latest: string | null) {
  return canUse(person, rule) || mayApprove(person, rule, risk, latest);
}

// A person's words the model read: where they sit in the thread, whether their writer can post
// now, and whether they may use the tool directly.
export interface Influence {
  seq: number;
  userId: string;
  canPost: boolean;
  canUse: boolean;
}

// A vouch: where it was given, who gave it, whether its giver may still approve, and for one given
// for now the call it was given on.
export interface Approval {
  atSeq: number;
  by: string;
  eligible: boolean;
  callId?: string;
}

// Whether a vouch still holds: its giver may still approve, and everyone who wrote after it may
// still speak for it. Who may is the one difference between the vouches. A vouch for now covers
// calls not yet made, so each later writer must be able to use the tool themselves, since their
// words steer those calls; with the giver's login, the later words must be the giver's own. A
// vouch once covers one call already made, which later words cannot change, so it survives a
// later writer who can still post, and only a writer who lost access drops it.
export function holds(
  approval: Approval,
  influence: readonly Influence[],
  maySpeak: (words: Influence) => boolean,
) {
  return (
    approval.eligible && influence.every((words) => words.seq <= approval.atSeq || maySpeak(words))
  );
}

export const usesTool = (words: Influence) => words.canUse;
export const stillPosts = (words: Influence) => words.canPost;
export const isGiver = (approval: Approval) => (words: Influence) => words.userId === approval.by;

// What becomes of a call: it runs on its own, runs on a vouch for now (given on the call named),
// or waits for a decision. One that runs with a person's own login says whose.
export type Decision =
  | { kind: "run"; runAs?: string }
  | { kind: "standing"; callId?: string; runAs?: string }
  | { kind: "wait" };

const WAIT: Decision = { kind: "wait" };

// Whether a call runs on its own, runs on a vouch for now, or waits for a decision. For a tool
// whose calls go with one person's own login, `connected` says whose login works.
export function decide(input: {
  declared: ToolRisk;
  rule: ToolRule;
  influence: readonly Influence[];
  standing: readonly Approval[];
  connected?: (userId: string) => boolean;
}): Decision {
  const { declared, rule, influence, standing, connected } = input;
  const risk = riskOf(declared, rule);
  // Where the tool or its rule asks for approval or independent review, every call waits.
  if (risk !== "normal") return WAIT;
  // Whose login a direct run goes with: the one person who wrote everything, if there is one.
  const writers = new Set(influence.map((words) => words.userId));
  const owner = writers.size === 1 ? [...writers][0]! : null;
  const direct = influence.every(usesTool);
  if (direct && (!connected || (owner && connected(owner)))) {
    return connected ? { kind: "run", runAs: owner! } : { kind: "run" };
  }
  // The latest vouch that holds, so a call runs as whoever gave it.
  const held = standing
    .filter((approval) =>
      holds(
        { ...approval, eligible: approval.eligible && (!connected || connected(approval.by)) },
        influence,
        connected ? isGiver(approval) : usesTool,
      ),
    )
    .sort((a, b) => b.atSeq - a.atSeq)[0];
  if (!held) return WAIT;
  return {
    kind: "standing",
    ...(held.callId && { callId: held.callId }),
    ...(connected && { runAs: held.by }),
  };
}
