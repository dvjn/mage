// The Policies card: the org's or a space's policies with a summary of each and how many tools use
// it. A space sees the org's policies beside its own.

import { RowBadge } from "@/web/shell/settings-row";
import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { type ReactNode } from "react";

import { type ToolPolicy } from "@/shared/tools.ts";
import { SettingsCard } from "@/web/shell/settings-page";
import { Button } from "@/web/components/ui/button";
import { PolicyDot, PolicyTags } from "@/web/agent/policies/tags";
import { usePolicies } from "@/web/agent/policies/provider";

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
          {organization && <RowBadge>Organization</RowBadge>}
        </span>
        <PolicyTags rule={{ off: false, ...policy }} />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {policy.toolCount === 1 ? "1 tool" : `${policy.toolCount} tools`}
      </span>
    </>
  );
  const rowClass = "flex w-full items-start gap-3 px-2 py-3 text-left";
  return (
    <li aria-label={policy.name}>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            rowClass,
            "rounded-md outline-none hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
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
