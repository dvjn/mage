// The dialog that makes and edits a policy, starting from a template, with who can use it without
// approval and who approves everyone else.

import { cn } from "cn";
import { useId, useState } from "react";

import { policyColorSchema, type PolicyUse } from "@/shared/tools.ts";
import { Button } from "@/web/components/ui/button";
import { Checkbox } from "@/web/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { FieldError } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/web/components/ui/radio-group";
import { WithTooltip } from "@/web/components/with-tooltip";
import {
  type Draft,
  TEMPLATES,
  type Template,
  freeColor,
  inputOf,
  templateOf,
} from "@/web/agent/policies/model";
import { COLORS } from "@/web/agent/policies/tags";
import { type DialogState, usePolicies } from "@/web/agent/policies/provider";
import { IdentityPicker } from "@/web/agent/policies/identity-picker";
import { useRemovePolicy, useSavePolicy } from "@/web/agent/mutations";

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

export function PolicyDialog({
  state,
  onState,
}: {
  state: DialogState;
  onState: (state: DialogState | null) => void;
}) {
  const { scope, policies, change } = usePolicies();
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
  const editing = state.mode === "edit" ? state.policy : null;
  const target = state.mode === "new" ? state.target : null;
  const noApprover = draft.use !== "everyone" && draft.approvers.length === 0;
  const template = templateOf(draft);
  const update = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const saving = useSavePolicy(scope, async (saved) => {
    if (target) await change(target.toolIds, saved.id);
  });
  const removal = useRemovePolicy(scope);
  const error = (saving.error ?? removal.error)?.message;
  const pending = saving.isPending || removal.isPending;

  function save() {
    removal.reset();
    saving.mutate({ id: editing?.id, json: inputOf(draft) }, { onSuccess: () => onState(null) });
  }

  function remove() {
    if (!editing) return;
    saving.reset();
    removal.mutate(editing.id, { onSuccess: () => onState(null) });
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
            if (draft.name.trim() && !noApprover && !pending) save();
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
                      onClick={() => remove()}
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
