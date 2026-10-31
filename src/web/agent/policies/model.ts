// Access policies as the settings show them: what a tool set to one is under, the org's and a
// space's rules as one, the rule in a few words, and the templates a new policy starts from.

import {
  EDITORS,
  type PolicyColor,
  policyColorSchema,
  type PolicyIdentity,
  type PolicyUse,
  TOOL_OFF,
  type ToolPolicy,
  type ToolPolicyInput,
} from "@/shared/tools.ts";
import type { Scope } from "@/web/shell/scope";

export function policiesKey(scope: Scope) {
  return scope.kind === "org" ? ["org-tool-policies"] : ["spaces", scope.spaceId, "tool-policies"];
}

// A rule as summaries show it, with the people and groups it names.
export interface Shown {
  off: boolean;
  use: PolicyUse;
  users: PolicyIdentity[];
  approvers: PolicyIdentity[];
  independent: boolean;
}

const OPEN: Shown = {
  off: false,
  use: "everyone",
  users: [],
  approvers: [],
  independent: false,
};

// What a tool set to the assignment is under: open when nothing is set, nobody when the policy is
// gone.
export function shownOf(assignment: string | null, byId: Map<string, ToolPolicy>): Shown {
  if (assignment === null) return OPEN;
  if (assignment === TOOL_OFF) return { ...OPEN, off: true };
  const policy = byId.get(assignment);
  if (!policy)
    return {
      off: false,
      use: "none",
      users: [],
      approvers: [],
      independent: false,
    };
  return { off: false, ...policy };
}

function common(a: PolicyIdentity[], b: PolicyIdentity[]) {
  return a.filter((one) => b.some((other) => other.key === one.key));
}

// The org's policy and a space's extra rule as one: someone uses a tool directly only if both let
// them; an approver must suit every rule that asks for approval; independent if either says so;
// off if either is.
function combine(a: Shown, b: Shown | null): Shown {
  if (!b) return a;
  const off = a.off || b.off;
  const asking = [a, b].filter((rule) => rule.use !== "everyone");
  const approvers = asking.length
    ? asking.map((rule) => rule.approvers).reduce((x, y) => common(x, y))
    : [];
  const independent = asking.some((rule) => rule.independent);
  if (a.use === "none" || b.use === "none") {
    return { off, use: "none", users: [], approvers, independent };
  }
  if (a.use === "everyone" && b.use === "everyone") return { ...OPEN, off };
  const users =
    a.use === "everyone" ? b.users : b.use === "everyone" ? a.users : common(a.users, b.users);
  return {
    off,
    use: users.length ? "some" : "none",
    users,
    approvers,
    independent,
  };
}

export type Tone = "open" | "team" | "need" | "independent" | "off";

function shortName(identity: PolicyIdentity) {
  return identity.kind === "editors" ? "Thread editors" : identity.name;
}

// The rule in a few tags: who uses it, who approves, and whether independently.
export function tagsOf(rule: Shown): { text: string; tone: Tone }[] {
  if (rule.off) return [{ text: "Off", tone: "off" }];
  if (rule.use === "everyone") return [{ text: "Anyone can use", tone: "open" }];
  const users = rule.users.map(shortName);
  const approvers = rule.approvers.map(shortName);
  const plural = approvers.length > 1 || rule.approvers[0]?.kind === "editors";
  return [
    ...(users.length ? [{ text: `${users.join(", ")} can use`, tone: "team" as const }] : []),
    {
      text: `${approvers.join(", ") || "No one"} ${plural ? "approve" : "approves"}`,
      tone: "need",
    },
    ...(rule.independent ? [{ text: "Independent", tone: "independent" as const }] : []),
  ];
}

export function summaryOf(rule: Shown) {
  return tagsOf(rule)
    .map((tag) => tag.text)
    .join(" · ");
}

export const UNSET = "unset";

export function nameOf(value: string | null, byId: Map<string, ToolPolicy>) {
  if (value === null) return "Open";
  if (value === TOOL_OFF) return "Off";
  return byId.get(value)?.name ?? "Removed policy";
}

// What applies to a tool in the space, the org's policy with the space's extra rule.
export function effectiveRule(
  orgPolicy: string | null,
  extra: string | null,
  byId: Map<string, ToolPolicy>,
) {
  return combine(shownOf(orgPolicy, byId), extra === null ? null : shownOf(extra, byId));
}

// A policy as the dialog edits it.
export interface Draft {
  name: string;
  color: PolicyColor;
  use: PolicyUse;
  users: PolicyIdentity[];
  approvers: PolicyIdentity[];
  independent: boolean;
}

export const TEMPLATES = {
  open: {
    name: "Anyone can use",
    description: "No approval needed",
    use: "everyone",
    independent: false,
  },
  team: {
    name: "Some can use",
    description: "Others need approval",
    use: "some",
    independent: false,
  },
  signoff: {
    name: "Always approve",
    description: "Every call needs approval",
    use: "none",
    independent: false,
  },
  independent: {
    name: "Independent approval",
    description: "Approver isn't the person who asked",
    use: "none",
    independent: true,
  },
} satisfies Record<
  string,
  { name: string; description: string; use: PolicyUse; independent: boolean }
>;

export type Template = keyof typeof TEMPLATES;

// The first colour no policy has yet.
export function freeColor(policies: ToolPolicy[]): PolicyColor {
  const used = new Set(policies.map((policy) => policy.color));
  return policyColorSchema.options.find((color) => !used.has(color)) ?? "gray";
}

export function draftFor(template: Template, policies: ToolPolicy[]): Draft {
  const { use, independent } = TEMPLATES[template];
  return {
    name: "",
    color: freeColor(policies),
    use,
    users: [],
    approvers: [],
    independent,
  };
}

// The template the form matches now, if any.
export function templateOf(draft: Draft): Template | null {
  const found = Object.entries(TEMPLATES).find(
    ([, template]) => template.use === draft.use && template.independent === draft.independent,
  );
  return found ? (found[0] as Template) : null;
}

export function inputOf(draft: Draft): ToolPolicyInput {
  return {
    name: draft.name.trim(),
    color: draft.color,
    use: draft.use,
    users: draft.use === "some" ? draft.users.map((identity) => identity.key) : [],
    approvers: draft.use === "everyone" ? [] : draft.approvers.map((identity) => identity.key),
    independent: draft.use !== "everyone" && draft.independent,
  };
}

export const EDITORS_IDENTITY: PolicyIdentity = {
  key: EDITORS,
  kind: "editors",
  name: "Anyone who can edit the thread",
  detail: "System",
  stale: false,
};
