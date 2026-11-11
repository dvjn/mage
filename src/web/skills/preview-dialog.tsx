// A read-only preview of a skill's files.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { useState } from "react";

import { type SkillSummary } from "@/shared/skills.ts";
import { Button } from "@/web/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { ResponsiveDialog, ResponsiveDialogContent } from "@/web/components/responsive-dialog";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { skillQuery } from "@/web/skills/queries";

// A skill's files, read-only: SKILL.md and what comes with it, scripts marked as never run.
export function SkillPreviewDialog({
  skill,
  line,
  onClose,
}: {
  skill: SkillSummary;
  line: string | null;
  onClose: () => void;
}) {
  const detail = useQuery(skillQuery(skill.id));
  const [file, setFile] = useState("SKILL.md");
  const files = detail.data
    ? [{ path: "SKILL.md", text: detail.data.body }, ...detail.data.files]
    : [];
  const current = files.find((candidate) => candidate.path === file) ?? files[0];
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{skill.name}</DialogTitle>
          <DialogDescription>
            {skill.description}
            {line && (
              <>
                <br />
                <span className="font-mono text-xs">{line}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {detail.error ? (
          <FieldError>Couldn't read this skill.</FieldError>
        ) : !detail.data ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Reading…
          </p>
        ) : (
          <div className="grid min-h-0 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div role="tablist" aria-label="Files" className="flex flex-col gap-0.5">
              {files.map((candidate) => (
                <button
                  key={candidate.path}
                  type="button"
                  role="tab"
                  aria-selected={candidate.path === current?.path}
                  onClick={() => setFile(candidate.path)}
                  className={cn(
                    "flex items-center justify-between gap-2 truncate rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-muted",
                    candidate.path === current?.path && "bg-muted font-medium",
                  )}
                >
                  <span className="truncate">{candidate.path}</span>
                  {candidate.path.startsWith("scripts/") && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">not run</span>
                  )}
                </button>
              ))}
            </div>
            <pre
              aria-label={current?.path}
              className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {current?.text}
            </pre>
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
