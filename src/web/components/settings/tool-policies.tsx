// Access policies in tools settings: the Policies card listing the org's or a space's policies
// with a summary of each and how many tools use it; the picker that sets a tool, or a group of
// tools, to a policy or off; and the dialog that makes and edits a policy, starting from a
// template, with who can use it without approval and who approves everyone else. A space sees the
// org's policies beside its own, and on the org's tools it follows the org's by default or picks
// a stricter one on top. Everything here reads and changes the policies through one provider per settings page.

import { queryOptions, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronDownIcon, PlusIcon, UsersIcon } from "lucide-react";
import { createContext, type ReactNode, use, useId, useState } from "react";

import {
  EDITORS,
  type PolicyColor,
  policyColorSchema,
  type PolicyIdentity,
  type PolicyUse,
  TOOL_OFF,
  type ToolPolicy,
  type ToolPolicyInput,
  toolPolicyListSchema,
  toolPolicySchema,
} from "@/shared/tools.ts";
import { SettingsCard } from "@/web/components/settings/layout";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Checkbox } from "@/web/components/ui/checkbox";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/web/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/web/components/ui/radio-group";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useDebounced } from "@/web/hooks/use-debounced";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { groupsPages, membersPages } from "@/web/lib/list-queries";
import { initialsOf } from "@/web/lib/initials";

// Whose policies and tools settings show: the org's, or one space's.
export type PolicyScope = { kind: "org" } | { kind: "space"; spaceId: string };

export function policiesKey(scope: PolicyScope) {
  return scope.kind === "org" ? ["org-tool-policies"] : ["spaces", scope.spaceId, "tool-policies"];
}

function policiesQuery(scope: PolicyScope) {
  return queryOptions({
    queryKey: policiesKey(scope),
    queryFn: async () => {
      const res =
        scope.kind === "org"
          ? await apiClient.v1.org["tool-policies"].$get()
          : await apiClient.v1.spaces[":id"]["tool-policies"].$get({
              param: { id: scope.spaceId },
            });
      if (!res.ok) throw new Error("could not read the policies");
      return toolPolicyListSchema.parse(await res.json());
    },
  });
}

const COLORS: Record<PolicyColor, string> = {
  green: "bg-green-600 dark:bg-green-400",
  emerald: "bg-emerald-600 dark:bg-emerald-400",
  teal: "bg-teal-600 dark:bg-teal-400",
  cyan: "bg-cyan-600 dark:bg-cyan-400",
  sky: "bg-sky-600 dark:bg-sky-400",
  blue: "bg-blue-600 dark:bg-blue-400",
  indigo: "bg-indigo-600 dark:bg-indigo-400",
  violet: "bg-violet-600 dark:bg-violet-400",
  purple: "bg-purple-600 dark:bg-purple-400",
  fuchsia: "bg-fuchsia-600 dark:bg-fuchsia-400",
  pink: "bg-pink-600 dark:bg-pink-400",
  orange: "bg-orange-600 dark:bg-orange-400",
  amber: "bg-amber-600 dark:bg-amber-400",
  yellow: "bg-yellow-600 dark:bg-yellow-400",
  lime: "bg-lime-600 dark:bg-lime-400",
  gray: "bg-zinc-500 dark:bg-zinc-400",
};

// A policy's colour, or how off and nothing set show.
export function PolicyDot({ color, kind }: { color?: PolicyColor; kind?: "off" | "unset" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full",
        kind === "off" && "border-2 border-destructive",
        kind === "unset" && "border border-dashed border-muted-foreground",
        !kind && COLORS[color ?? "gray"],
      )}
    />
  );
}

// A rule as summaries show it, with the people and groups it names.
interface Shown {
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
function shownOf(assignment: string | null, byId: Map<string, ToolPolicy>): Shown {
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

type Tone = "open" | "team" | "need" | "independent" | "off";

const TONES: Record<Tone, string> = {
  open: "bg-green-500/10 text-green-700 dark:text-green-400",
  team: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  need: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  independent: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  off: "bg-destructive/10 text-destructive",
};

function shortName(identity: PolicyIdentity) {
  return identity.kind === "editors" ? "Thread editors" : identity.name;
}

// The rule in a few tags: who uses it, who approves, and whether independently.
function tagsOf(rule: Shown): { text: string; tone: Tone }[] {
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

function summaryOf(rule: Shown) {
  return tagsOf(rule)
    .map((tag) => tag.text)
    .join(" · ");
}

export function PolicyTags({ rule, className }: { rule: Shown; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {tagsOf(rule).map((tag) => (
        <Badge
          key={tag.text}
          variant="secondary"
          className={cn("h-5 max-w-full truncate font-normal", TONES[tag.tone])}
        >
          {tag.text}
        </Badge>
      ))}
    </span>
  );
}

// The tools a new policy will be set on once made, and what they are called.
export interface PolicyTarget {
  toolIds: string[];
  label: string;
}

type DialogState =
  | { mode: "new"; target: PolicyTarget | null; draft: Draft }
  | { mode: "edit"; policy: ToolPolicy };

interface PolicyContextValue {
  scope: PolicyScope;
  state: { isPending: boolean; error: Error | null };
  // The policies the scope can use: for a space, its own and the org's.
  policies: ToolPolicy[];
  byId: Map<string, ToolPolicy>;
  canChange: boolean;
  change: (toolIds: string[], policy: string | null) => Promise<void>;
  create: (target: PolicyTarget | null) => void;
  edit: (policy: ToolPolicy) => void;
}

const PolicyContext = createContext<PolicyContextValue | null>(null);

export function usePolicies() {
  const value = use(PolicyContext);
  if (!value) throw new Error("usePolicies needs ToolPoliciesProvider");
  return value;
}

// The policies of the scope, the change that sets tools to one, and the dialog that makes and
// edits them, for everything inside.
export function ToolPoliciesProvider({
  scope,
  canChange,
  change,
  children,
}: {
  scope: PolicyScope;
  canChange: boolean;
  // Sets the tools to the policy, off or nothing; resolves once done.
  change: (toolIds: string[], policy: string | null) => Promise<void>;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const policies = useQuery(policiesQuery(scope));
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const list = policies.data ?? [];
  const byId = new Map(list.map((policy) => [policy.id, policy]));

  async function changeAndCount(toolIds: string[], policy: string | null) {
    await change(toolIds, policy);
    await queryClient.invalidateQueries({ queryKey: policiesKey(scope) });
  }

  const value: PolicyContextValue = {
    scope,
    state: policies,
    policies: list,
    byId,
    canChange,
    change: changeAndCount,
    create: (target) => setDialog({ mode: "new", target, draft: draftFor("open", list) }),
    edit: (policy) => setDialog({ mode: "edit", policy }),
  };

  return (
    <PolicyContext value={value}>
      {children}
      {dialog && (
        <PolicyDialog
          key={dialog.mode === "edit" ? dialog.policy.id : "new"}
          state={dialog}
          onState={setDialog}
        />
      )}
    </PolicyContext>
  );
}

// The Policies card: the scope's own, and in a space the org's below them, each opening to edit.
export function PoliciesCard() {
  const { scope, state, policies, canChange, create, edit } = usePolicies();
  const own = policies.filter((policy) =>
    scope.kind === "org" ? policy.spaceId === null : policy.spaceId === scope.spaceId,
  );
  const fromOrg = scope.kind === "space" ? policies.filter((policy) => !policy.spaceId) : [];
  return (
    <SettingsCard
      title="Policies"
      description={
        scope.kind === "org"
          ? "Reusable access rules, available in every space. Tools without one are open to everyone."
          : "Organization policies can be used here. Policies made here stay in this space."
      }
      action={
        canChange && (
          <Button variant="outline" size="sm" onClick={() => create(null)}>
            <PlusIcon />
            New policy
          </Button>
        )
      }
      state={state}
    >
      <div className="-my-2 flex flex-col">
        {scope.kind === "space" && <SubHeading>This space</SubHeading>}
        {own.length === 0 && <p className="py-2 text-sm text-muted-foreground">None yet.</p>}
        <ul className="flex flex-col divide-y">
          {own.map((policy) => (
            <PolicyRow
              key={policy.id}
              policy={policy}
              onEdit={canChange ? () => edit(policy) : undefined}
            />
          ))}
        </ul>
        {scope.kind === "space" && (
          <>
            <SubHeading>From the organization</SubHeading>
            {fromOrg.length === 0 && <p className="py-2 text-sm text-muted-foreground">None.</p>}
            <ul className="flex flex-col divide-y">
              {fromOrg.map((policy) => (
                <PolicyRow key={policy.id} policy={policy} organization />
              ))}
            </ul>
          </>
        )}
      </div>
    </SettingsCard>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function PolicyRow({
  policy,
  organization,
  onEdit,
}: {
  policy: ToolPolicy;
  organization?: boolean;
  onEdit?: () => void;
}) {
  const body = (
    <>
      <span className="flex h-5 items-center">
        <PolicyDot color={policy.color} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{policy.name}</span>
          {organization && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              Organization
            </Badge>
          )}
        </span>
        <PolicyTags rule={{ off: false, ...policy }} />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {policy.toolCount === 1 ? "1 tool" : `${policy.toolCount} tools`}
      </span>
    </>
  );
  const rowClass = "flex w-full items-start gap-3 py-3 text-left";
  return (
    <li aria-label={policy.name}>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            rowClass,
            "-mx-2 w-[calc(100%+1rem)] rounded-md px-2 outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  );
}

const UNSET = "unset";

// The name and dot of what a tool is set to.
export function AssignmentLabel({
  value,
  extra,
  inherited,
  mixed,
}: {
  value: string | null;
  // In a space on the org's tools, nothing set means following the org's policy.
  extra?: boolean;
  // The org's policy followed, when the tools share one.
  inherited?: string | null;
  mixed?: boolean;
}) {
  const { byId } = usePolicies();
  if (mixed) return <span className="truncate text-muted-foreground">Mixed</span>;
  if (value === null && extra) {
    if (inherited === undefined) {
      return (
        <>
          <PolicyDot kind="unset" />
          <span className="truncate">Default</span>
        </>
      );
    }
    return (
      <>
        <AssignmentDot value={inherited} />
        <span className="truncate">Default · {nameOf(inherited, byId)}</span>
      </>
    );
  }
  if (value === null) {
    return (
      <>
        <PolicyDot kind="unset" />
        <span className="truncate">Open</span>
      </>
    );
  }
  if (value === TOOL_OFF) {
    return (
      <>
        <PolicyDot kind="off" />
        <span className="truncate">Off</span>
      </>
    );
  }
  const policy = byId.get(value);
  return (
    <>
      <PolicyDot color={policy?.color} />
      <span className="truncate">{policy?.name ?? "Removed policy"}</span>
    </>
  );
}

function AssignmentDot({ value }: { value: string | null }) {
  const { byId } = usePolicies();
  if (value === null) return <PolicyDot kind="unset" />;
  if (value === TOOL_OFF) return <PolicyDot kind="off" />;
  return <PolicyDot color={byId.get(value)?.color} />;
}

function nameOf(value: string | null, byId: Map<string, ToolPolicy>) {
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

// Sets a tool or a group of tools to a policy, off or nothing; or makes a new policy for them.
export function PolicyPicker({
  label,
  value,
  mixed = false,
  extra = false,
  inherited,
  target,
}: {
  label: string;
  value: string | null;
  mixed?: boolean;
  // In a space on the org's tools: the first entry follows the org's policy, and another is
  // added on top of it.
  extra?: boolean;
  // The org's policy for the tools, when they share one.
  inherited?: string | null;
  target: PolicyTarget;
}) {
  const { scope, policies, byId, canChange, change, create } = usePolicies();
  const what = target.toolIds.length === 1 ? "this tool" : "these tools";
  const known = extra && inherited !== undefined;
  // On the org's tools, what a choice comes to with the org's policy under it.
  const applied =
    known && value !== null && !mixed
      ? `With the organization's ${nameOf(inherited, byId)}: ${summaryOf(effectiveRule(inherited, value, byId))}`
      : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={label}
            title={applied}
            disabled={!canChange}
            className="w-32 shrink-0 justify-between font-normal sm:w-40"
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <AssignmentLabel value={value} extra={extra} inherited={inherited} mixed={mixed} />
        </span>
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuRadioGroup
          value={mixed ? "" : (value ?? UNSET)}
          onValueChange={(next: string) =>
            void change(target.toolIds, next === UNSET ? null : next)
          }
        >
          {extra ? (
            <PickerItem
              value={UNSET}
              dot={known ? <AssignmentDot value={inherited} /> : <PolicyDot kind="unset" />}
              name="Default"
              summary={
                known
                  ? `Organization: ${nameOf(inherited, byId)}`
                  : "Each tool follows the organization's policy"
              }
            />
          ) : (
            <PickerItem
              value={UNSET}
              dot={<PolicyDot kind="unset" />}
              name="Open"
              summary="Anyone can use, no approval"
            />
          )}
          <DropdownMenuSeparator />
          {policies.map((policy) => (
            <PickerItem
              key={policy.id}
              value={policy.id}
              dot={<PolicyDot color={policy.color} />}
              name={policy.name}
              badge={scope.kind === "space" && policy.spaceId ? "This space" : undefined}
              summary={summaryOf(shownOf(policy.id, byId))}
            />
          ))}
          {policies.length > 0 && <DropdownMenuSeparator />}
          <PickerItem
            value={TOOL_OFF}
            dot={<PolicyDot kind="off" />}
            name="Off"
            summary={`The agent can't use ${what}${extra ? " in this space" : ""}`}
          />
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => create(target)}>
          <PlusIcon />
          New policy
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PickerItem({
  value,
  dot,
  name,
  badge,
  summary,
}: {
  value: string;
  dot: ReactNode;
  name: string;
  badge?: string;
  summary: string;
}) {
  return (
    <DropdownMenuRadioItem value={value} closeOnClick className="items-start gap-2 py-1.5">
      <span className="flex h-5 items-center">{dot}</span>
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 font-medium">
          {name}
          {badge && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              {badge}
            </Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{summary}</span>
      </span>
    </DropdownMenuRadioItem>
  );
}

// A policy as the dialog edits it.
interface Draft {
  name: string;
  color: PolicyColor;
  use: PolicyUse;
  users: PolicyIdentity[];
  approvers: PolicyIdentity[];
  independent: boolean;
}

const TEMPLATES = {
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

type Template = keyof typeof TEMPLATES;

// The first colour no policy has yet.
function freeColor(policies: ToolPolicy[]): PolicyColor {
  const used = new Set(policies.map((policy) => policy.color));
  return policyColorSchema.options.find((color) => !used.has(color)) ?? "gray";
}

function draftFor(template: Template, policies: ToolPolicy[]): Draft {
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
function templateOf(draft: Draft): Template | null {
  const found = Object.entries(TEMPLATES).find(
    ([, template]) => template.use === draft.use && template.independent === draft.independent,
  );
  return found ? (found[0] as Template) : null;
}

function inputOf(draft: Draft): ToolPolicyInput {
  return {
    name: draft.name.trim(),
    color: draft.color,
    use: draft.use,
    users: draft.use === "some" ? draft.users.map((identity) => identity.key) : [],
    approvers: draft.use === "everyone" ? [] : draft.approvers.map((identity) => identity.key),
    independent: draft.use !== "everyone" && draft.independent,
  };
}

const USES: { value: PolicyUse; label: string; description: string }[] = [
  {
    value: "everyone",
    label: "Everyone",
    description: "No approval is ever needed.",
  },
  {
    value: "some",
    label: "Only these people",
    description: "Anyone else in the thread needs approval.",
  },
  { value: "none", label: "No one", description: "Every call needs approval." },
];

function PolicyDialog({
  state,
  onState,
}: {
  state: DialogState;
  onState: (state: DialogState | null) => void;
}) {
  const { scope, policies, change } = usePolicies();
  const queryClient = useQueryClient();
  const nameId = useId();
  const [draft, setDraft] = useState<Draft>(() =>
    state.mode === "new"
      ? state.draft
      : {
          name: state.policy.name,
          color: state.policy.color,
          use: state.policy.use,
          users: state.policy.users,
          approvers: state.policy.approvers,
          independent: state.policy.independent,
        },
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const editing = state.mode === "edit" ? state.policy : null;
  const target = state.mode === "new" ? state.target : null;
  const noApprover = draft.use !== "everyone" && draft.approvers.length === 0;
  const template = templateOf(draft);
  const update = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  async function settled() {
    await queryClient.invalidateQueries({ queryKey: policiesKey(scope) });
    await queryClient.invalidateQueries({ queryKey: ["org-tool-policies"] });
    await queryClient.invalidateQueries({ queryKey: ["threads"] });
  }

  async function save() {
    setPending(true);
    setError(undefined);
    const json = inputOf(draft);
    const res = editing
      ? scope.kind === "org"
        ? await apiClient.v1.org["tool-policies"][":policyId"].$put({
            param: { policyId: editing.id },
            json,
          })
        : await apiClient.v1.spaces[":id"]["tool-policies"][":policyId"].$put({
            param: { id: scope.spaceId, policyId: editing.id },
            json,
          })
      : scope.kind === "org"
        ? await apiClient.v1.org["tool-policies"].$post({ json })
        : await apiClient.v1.spaces[":id"]["tool-policies"].$post({
            param: { id: scope.spaceId },
            json,
          });
    if (!res.ok) {
      setPending(false);
      setError(await errorOf(res));
      return;
    }
    const saved = toolPolicySchema.parse(await res.json());
    if (target) await change(target.toolIds, saved.id);
    await settled();
    setPending(false);
    onState(null);
  }

  async function remove() {
    if (!editing) return;
    setPending(true);
    setError(undefined);
    const res =
      scope.kind === "org"
        ? await apiClient.v1.org["tool-policies"][":policyId"].$delete({
            param: { policyId: editing.id },
          })
        : await apiClient.v1.spaces[":id"]["tool-policies"][":policyId"].$delete({
            param: { id: scope.spaceId, policyId: editing.id },
          });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await settled();
    onState(null);
  }

  const where = scope.kind === "org" ? "Available in every space." : "Only in this space.";
  const about = editing
    ? `Used by ${editing.toolCount === 1 ? "1 tool" : `${editing.toolCount} tools`}. Changes apply to all of them.`
    : target
      ? `It will be used for ${target.label}.`
      : "";

  return (
    <Dialog open onOpenChange={(open) => !open && onState(null)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.name.trim() && !noApprover && !pending) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? "Edit policy" : "New policy"}</DialogTitle>
            <DialogDescription>
              {where} {about}
            </DialogDescription>
          </DialogHeader>

          {!editing && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Template</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Template">
                {(Object.entries(TEMPLATES) as [Template, (typeof TEMPLATES)[Template]][]).map(
                  ([key, item]) => (
                    <WithTooltip key={key} label={item.description}>
                      <button
                        type="button"
                        aria-pressed={template === key}
                        onClick={() => update({ use: item.use, independent: item.independent })}
                        className="h-7 rounded-full border border-dashed px-3 text-xs outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:border-solid aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
                      >
                        {item.name}
                      </button>
                    </WithTooltip>
                  ),
                )}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
              {policyColorSchema.options.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === color}
                  aria-label={color}
                  title={color}
                  onClick={() => update({ color })}
                  className={cn(
                    "size-5 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-checked:ring-2 aria-checked:ring-foreground",
                    COLORS[color],
                  )}
                />
              ))}
            </div>
            <Input
              id={nameId}
              value={draft.name}
              autoComplete="off"
              placeholder="For example: Release managers"
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium" id={`${nameId}-use`}>
              1. Who can use it without approval?
            </span>
            <RadioGroup
              aria-labelledby={`${nameId}-use`}
              value={draft.use}
              onValueChange={(use) => update({ use: use as PolicyUse })}
            >
              {USES.map((option) => (
                <Label key={option.value} className="items-start gap-2 font-normal">
                  <RadioGroupItem value={option.value} className="mt-0.5" />
                  <span className="flex flex-col">
                    {option.label}
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
            {draft.use === "some" && (
              <IdentityPicker
                label="People who can use it"
                value={draft.users}
                onChange={(users) => update({ users })}
              />
            )}
          </div>

          {draft.use !== "everyone" && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                2. Who approves {draft.use === "some" ? "everyone else" : "each call"}?
              </span>
              <IdentityPicker
                label="Approvers"
                value={draft.approvers}
                onChange={(approvers) => update({ approvers })}
                editors
              />
              <Label className="items-start gap-2 font-normal">
                <Checkbox
                  className="mt-0.5"
                  checked={draft.independent}
                  onCheckedChange={(independent) => update({ independent })}
                />
                <span className="flex flex-col">
                  Independent approval
                  <span className="text-xs text-muted-foreground">
                    The approver can't be the person whose message asked for the call.
                  </span>
                </span>
              </Label>
              {noApprover && (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Pick at least one approver, or every call that needs approval is refused.
                </p>
              )}
            </div>
          )}

          {scope.kind === "space" && (
            <p className="text-xs text-muted-foreground">
              On organization tools, this adds to the organization's policy. Both have to allow
              something.
            </p>
          )}

          <FieldError>{error}</FieldError>

          <DialogFooter className="items-center sm:justify-between">
            <div className="flex gap-2">
              {editing && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      onState({
                        mode: "new",
                        target: null,
                        draft: {
                          ...draft,
                          name: `${draft.name} copy`,
                          color: freeColor(policies),
                        },
                      })
                    }
                  >
                    Duplicate
                  </Button>
                  {editing.toolCount > 0 ? (
                    <WithTooltip label="Move its tools to another policy first">
                      {/* A disabled button takes no pointer, so its wrapper holds the tooltip. */}
                      <span className="inline-flex">
                        <Button type="button" variant="destructive" disabled>
                          Delete
                        </Button>
                      </span>
                    </WithTooltip>
                  ) : (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => void remove()}
                    >
                      Delete
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onState(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !draft.name.trim() || noApprover}>
                {editing ? "Save" : "Create policy"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const EDITORS_IDENTITY: PolicyIdentity = {
  key: EDITORS,
  kind: "editors",
  name: "Anyone who can edit the thread",
  detail: "System",
  stale: false,
};

// People and groups of the org, as tokens: typing searches the directory, Enter adds the top
// match and Backspace takes back the last one. Approvers may also be anyone who can edit the
// thread.
function IdentityPicker({
  label,
  value,
  onChange,
  editors = false,
}: {
  label: string;
  value: PolicyIdentity[];
  onChange: (value: PolicyIdentity[]) => void;
  editors?: boolean;
}) {
  const anchor = useComboboxAnchor();
  const [text, setText] = useState("");
  const [highlighted, setHighlighted] = useState<PolicyIdentity>();
  const q = useDebounced(text.trim());
  const people = useInfiniteQuery(membersPages({ q }, 20));
  const groups = useInfiniteQuery(groupsPages({ q }, 20));
  const chosen = new Set(value.map((identity) => identity.key));
  const options: PolicyIdentity[] = [
    ...(editors && (!q || EDITORS_IDENTITY.name.toLowerCase().includes(q.toLowerCase()))
      ? [EDITORS_IDENTITY]
      : []),
    ...(groups.data?.pages[0]?.items ?? []).map((group) => ({
      key: `group:${group.id}`,
      kind: "group" as const,
      name: group.name,
      detail: `Group · ${group.memberCount} ${group.memberCount === 1 ? "person" : "people"}`,
      stale: false,
    })),
    ...(people.data?.pages[0]?.items ?? []).map((member) => ({
      key: `user:${member.userId}`,
      kind: "user" as const,
      name: member.name,
      detail: member.email,
      stale: false,
    })),
  ].filter((identity) => !chosen.has(identity.key));
  return (
    <Combobox
      multiple
      items={options}
      onItemHighlighted={(identity: PolicyIdentity | undefined) => setHighlighted(identity)}
      value={value}
      onValueChange={(next: PolicyIdentity[]) => {
        onChange(next);
        setText("");
      }}
      itemToStringLabel={(identity: PolicyIdentity) => identity.name}
      isItemEqualToValue={(a: PolicyIdentity, b: PolicyIdentity) => a.key === b.key}
      filter={null}
      inputValue={text}
      onInputValueChange={(next: string) => setText(next)}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {(selected: PolicyIdentity[]) => (
            <>
              {selected.map((identity) => (
                <ComboboxChip
                  key={identity.key}
                  className={cn(identity.stale && "text-muted-foreground line-through")}
                >
                  {identity.kind === "user" ? `@${identity.name}` : identity.name}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                aria-label={label}
                placeholder={selected.length ? "Add more" : "Search people and groups"}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter never sends the form; with nothing highlighted it adds the top match.
                  event.preventDefault();
                  if (highlighted || !options[0]) return;
                  onChange([...value, options[0]]);
                  setText("");
                }}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(identity: PolicyIdentity) => (
            <ComboboxItem key={identity.key} value={identity}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium">
                {identity.kind === "user" ? (
                  initialsOf(identity.name)
                ) : (
                  <UsersIcon className="size-3.5" />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{identity.name}</span>
                {identity.detail && (
                  <span className="truncate text-xs text-muted-foreground">{identity.detail}</span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// How many of the tools are set to each policy, and off: a dot and a number for each. In a space,
// a tool's extra rule counts where it has one.
export function PolicyCounts({
  tools,
}: {
  tools: { orgPolicy: string | null; policy: string | null }[];
}) {
  const { byId } = usePolicies();
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const key = tool.policy ?? tool.orgPolicy;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  const nameOf = (key: string) =>
    key === TOOL_OFF ? "Off" : (byId.get(key)?.name ?? "Removed policy");
  return (
    <span className="flex items-center gap-2.5">
      <span className="sr-only">
        {entries.map(([key, count]) => `${count} ${nameOf(key)}`).join(", ")}
      </span>
      {entries.map(([key, count]) => (
        <span key={key} aria-hidden className="flex items-center gap-1 tabular-nums">
          {key === TOOL_OFF ? <PolicyDot kind="off" /> : <PolicyDot color={byId.get(key)?.color} />}
          {count}
        </span>
      ))}
    </span>
  );
}
