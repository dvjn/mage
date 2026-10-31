// The org's or a space's access policies, read and changed through one provider per settings page,
// which also holds the policy dialog open.

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useState } from "react";

import { type ToolPolicy, toolPolicyListSchema } from "@/shared/tools.ts";
import { apiClient } from "@/web/api/api-client";
import type { Scope } from "@/web/shell/scope";
import { type Draft, draftFor, policiesKey } from "@/web/agent/policies/model";
import { PolicyDialog } from "@/web/agent/policies/policy-dialog";
import { useToolsChange } from "@/web/agent/mutations";
import { FieldError } from "@/web/components/ui/field";

function policiesQuery(scope: Scope) {
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

// The tools a new policy will be set on once made, and what they are called.
export interface PolicyTarget {
  toolIds: string[];
  label: string;
}

export type DialogState =
  | { mode: "new"; target: PolicyTarget | null; draft: Draft }
  | { mode: "edit"; policy: ToolPolicy };

interface PolicyContextValue {
  scope: Scope;
  state: { isPending: boolean; error: Error | null };
  // The policies the scope can use: for a space, its own and the org's.
  policies: ToolPolicy[];
  byId: Map<string, ToolPolicy>;
  canChange: boolean;
  change: (toolIds: string[], policy: string | null) => Promise<void>;
  // Why the last change of tools to a policy failed.
  changeError?: string;
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
  children,
}: {
  scope: Scope;
  canChange: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const policies = useQuery(policiesQuery(scope));
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const list = policies.data ?? [];
  const byId = new Map(list.map((policy) => [policy.id, policy]));

  const tools = useToolsChange(scope);

  // Sets the tools to the policy, off or nothing, then counts the policies' tools again.
  async function change(toolIds: string[], policy: string | null) {
    await tools.mutateAsync({ toolIds, policy }).catch(() => {});
    await queryClient.invalidateQueries({ queryKey: policiesKey(scope) });
  }

  const value: PolicyContextValue = {
    scope,
    state: policies,
    policies: list,
    byId,
    canChange,
    change,
    changeError: tools.error?.message,
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

// Why the last change of tools to a policy failed, where the tools are.
export function PolicyChangeError() {
  return <FieldError>{usePolicies().changeError}</FieldError>;
}
