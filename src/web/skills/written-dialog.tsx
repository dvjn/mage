// Writes a skill, or changes or deletes one written or uploaded here.

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { SKILL_NAME } from "@/shared/skills.ts";
import { useToast } from "@/web/shell/toaster";
import { Button } from "@/web/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { ResponsiveDialog, ResponsiveDialogContent } from "@/web/components/responsive-dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Textarea } from "@/web/components/ui/textarea";
import { apiClient } from "@/web/api/api-client";
import { skillQuery } from "@/web/skills/queries";
import type { Scope } from "@/web/shell/scope";
import { plural } from "@/web/lib/plural";
import { useChange } from "@/web/skills/mutations";
import type { WrittenRow } from "@/web/skills/card";
import { SkillPreviewDialog } from "@/web/skills/preview-dialog";

export type Draft = { name: string; description: string; body: string };

// A skill written or uploaded here, to change or delete; or a new one, from scratch or from an
// uploaded file that did not name or describe it. One with files previews them.
export function WrittenDialog({
  scope,
  row,
  initial,
  readOnly,
  onClose,
}: {
  scope: Scope;
  row: WrittenRow | null;
  initial?: Draft;
  readOnly: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const detail = useQuery({ ...skillQuery(row?.skill.id ?? ""), enabled: !!row });
  const [draft, setDraft] = useState<Draft | null>(
    row ? null : (initial ?? { name: "", description: "", body: "" }),
  );
  const [previewing, setPreviewing] = useState(false);
  const { error, pending, run } = useChange();
  const loaded = draft ??
    (detail.data && {
      name: detail.data.name,
      description: detail.data.description,
      body: detail.data.body,
    }) ?? { name: "", description: "", body: "" };
  const change = (fields: Partial<typeof loaded>) => setDraft({ ...loaded, ...fields });
  const badName = !!loaded.name && !SKILL_NAME.test(loaded.name);
  const ready = !badName && !!loaded.name && !!loaded.description.trim();

  async function save() {
    const json = loaded;
    const res = await run(() =>
      row
        ? apiClient.v1.skills[":id"].$patch({ param: { id: row.skill.id }, json })
        : scope.kind === "org"
          ? apiClient.v1.org.skills.$post({ json })
          : apiClient.v1.spaces[":id"].skills.$post({ param: { id: scope.spaceId }, json }),
    );
    if (!res) return;
    if (!row) toast(`Created ${json.name}`, "info");
    onClose();
  }

  async function remove() {
    if (!row) return;
    const res = await run(() =>
      apiClient.v1.skills[":id"].$delete({ param: { id: row.skill.id } }),
    );
    if (res) onClose();
  }

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row ? row.skill.name : "New skill"}</DialogTitle>
          <DialogDescription>
            {readOnly
              ? row?.locked
                ? "From the organization."
                : "Read only."
              : row
                ? "Changes apply from the next run."
                : "The agent loads it when a task needs it."}
          </DialogDescription>
        </DialogHeader>
        {readOnly ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{loaded.description}</p>
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
              {loaded.body}
            </pre>
          </div>
        ) : (
          <form
            id={`${id}-form`}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={loaded.name}
                  onChange={(event) => change({ name: event.target.value })}
                  placeholder="for-example-this"
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                />
                <FieldDescription>
                  {badName
                    ? "Lowercase letters, digits and single hyphens only."
                    : "Like write-release-notes"}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
                <Input
                  id={`${id}-description`}
                  value={loaded.description}
                  onChange={(event) => change({ description: event.target.value })}
                  placeholder="When to use it and what it does"
                  autoComplete="off"
                />
                <FieldDescription>One line; the agent reads it to decide.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-body`}>SKILL.md</FieldLabel>
                <Textarea
                  id={`${id}-body`}
                  value={loaded.body}
                  onChange={(event) => change({ body: event.target.value })}
                  placeholder={"# Title\n\nSteps the agent follows when it loads this skill."}
                  className="min-h-48 font-mono text-sm"
                />
              </Field>
              <FieldError>{error}</FieldError>
            </FieldGroup>
          </form>
        )}
        <DialogFooter>
          {row && !readOnly && (
            <Button
              variant="destructive"
              className="sm:mr-auto"
              disabled={pending}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          )}
          {row && row.skill.fileCount > 0 && (
            <Button
              variant="outline"
              className={readOnly ? "sm:mr-auto" : ""}
              onClick={() => setPreviewing(true)}
            >
              {plural(row.skill.fileCount, "file")}
            </Button>
          )}
          <DialogClose render={<Button variant="ghost" />}>
            {readOnly ? "Close" : "Cancel"}
          </DialogClose>
          {!readOnly && (
            <Button type="submit" form={`${id}-form`} disabled={pending || !ready}>
              {row ? "Save" : "Create skill"}
            </Button>
          )}
        </DialogFooter>
        {previewing && row && (
          <SkillPreviewDialog skill={row.skill} line={null} onClose={() => setPreviewing(false)} />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
