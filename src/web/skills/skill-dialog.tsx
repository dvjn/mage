// A skill's SKILL.md and files, one tab each: SKILL.md editable where the reader may change it.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
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
import { Spinner } from "@/web/components/ui/spinner";
import { Textarea } from "@/web/components/ui/textarea";
import { apiClient } from "@/web/api/api-client";
import { skillQuery } from "@/web/skills/queries";
import type { Scope } from "@/web/shell/scope";
import { useChange } from "@/web/skills/mutations";
import type { WrittenRow } from "@/web/skills/card";
import { learnedLine } from "@/web/skills/source-row";

export type Draft = { name: string; description: string; body: string };

const SKILL_MD = "SKILL.md";
const FILE_CLASS =
  "max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap";

// A skill to read, change or delete; or a new one, from scratch or from an uploaded file that did not
// name or describe it. A repository's skill comes with its source line and is read only.
export function SkillDialog({
  scope,
  row,
  line = null,
  initial,
  readOnly,
  deletable,
  onClose,
}: {
  scope: Scope;
  row: WrittenRow | null;
  line?: string | null;
  initial?: Draft;
  readOnly: boolean;
  // Whether the reader may delete it.
  deletable: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  // Once saving or deleting it, it is not read again: a saved learned skill is a new one.
  const [leaving, setLeaving] = useState(false);
  const detail = useQuery({ ...skillQuery(row?.skill.id ?? ""), enabled: !!row && !leaving });
  const [draft, setDraft] = useState<Draft | null>(
    row ? null : (initial ?? { name: "", description: "", body: "" }),
  );
  const [tab, setTab] = useState(SKILL_MD);
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
  const files = [{ path: SKILL_MD }, ...(detail.data?.files ?? [])];
  const file = detail.data?.files.find((candidate) => candidate.path === tab);
  const selected = file?.path ?? SKILL_MD;

  async function save() {
    const json = loaded;
    setLeaving(true);
    const res = await run(() =>
      row
        ? apiClient.v1.skills[":id"].$patch({ param: { id: row.skill.id }, json })
        : scope.kind === "org"
          ? apiClient.v1.org.skills.$post({ json })
          : apiClient.v1.spaces[":id"].skills.$post({ param: { id: scope.spaceId }, json }),
    );
    if (!res) return setLeaving(false);
    if (!row) toast(`Created ${json.name}`, "info");
    onClose();
  }

  async function remove() {
    if (!row) return;
    setLeaving(true);
    const res = await run(() =>
      apiClient.v1.skills[":id"].$delete({ param: { id: row.skill.id } }),
    );
    if (res) onClose();
    else setLeaving(false);
  }

  const skillMd = readOnly ? (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{loaded.description}</p>
      <pre aria-label={SKILL_MD} className={FILE_CLASS}>
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
          <FieldLabel htmlFor={`${id}-body`}>{SKILL_MD}</FieldLabel>
          <Textarea
            id={`${id}-body`}
            value={loaded.body}
            onChange={(event) => change({ body: event.target.value })}
            placeholder={"# Title\n\nSteps the agent follows when it loads this skill."}
            className="max-h-[50vh] min-h-48 font-mono text-sm"
          />
        </Field>
      </FieldGroup>
    </form>
  );

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{row ? row.skill.name : "New skill"}</DialogTitle>
          <DialogDescription className={cn(line && "font-mono text-xs")}>
            {row?.skill.learned && learnedLine(row.skill)
              ? learnedLine(row.skill)
              : line
                ? line
                : readOnly
                  ? row?.locked
                    ? "From the organization."
                    : "Read only."
                  : row
                    ? "Changes apply from the next run."
                    : "The agent loads it when a task needs it."}
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "min-h-0",
            files.length > 1 && "grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]",
          )}
        >
          {files.length > 1 && (
            <div role="tablist" aria-label="Files" className="flex flex-col gap-0.5">
              {files.map((candidate) => (
                <button
                  key={candidate.path}
                  type="button"
                  role="tab"
                  aria-selected={candidate.path === selected}
                  onClick={() => setTab(candidate.path)}
                  className={cn(
                    "flex items-center justify-between gap-2 truncate rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-muted",
                    candidate.path === selected && "bg-muted font-medium",
                  )}
                >
                  <span className="truncate">{candidate.path}</span>
                  {candidate.path.startsWith("scripts/") && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">not run</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {row && !draft && detail.error ? (
            <FieldError>Couldn't read this skill.</FieldError>
          ) : row && !draft && !detail.data ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Reading…
            </p>
          ) : (
            <div className="min-w-0">
              {file && (
                <pre aria-label={file.path} className={FILE_CLASS}>
                  {file.text}
                </pre>
              )}
              {/* Stays mounted behind another file's tab, so Save still submits the form. */}
              <div className={cn(file && "hidden")}>{skillMd}</div>
            </div>
          )}
        </div>
        <FieldError>{error}</FieldError>
        <DialogFooter>
          {row && deletable && (
            <Button
              variant="destructive"
              className="sm:mr-auto"
              disabled={pending}
              onClick={() => void remove()}
            >
              Delete
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
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
