// The picker that sets a tool, or a group of tools, to a policy or off; in a space, on the org's
// tools, it follows the org's policy by default or picks a stricter one on top.

import { RowBadge } from "@/web/shell/settings-row";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { type ReactNode } from "react";

import { TOOL_OFF } from "@/shared/tools.ts";
import { Button } from "@/web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { PolicyDot } from "@/web/agent/policies/tags";
import { UNSET, effectiveRule, nameOf, shownOf, summaryOf } from "@/web/agent/policies/model";
import { type PolicyTarget, usePolicies } from "@/web/agent/policies/provider";

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
          {badge && <RowBadge>{badge}</RowBadge>}
        </span>
        <span className="text-xs text-muted-foreground">{summary}</span>
      </span>
    </DropdownMenuRadioItem>
  );
}
