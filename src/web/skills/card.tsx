// The skills card in settings, for the org or a space. An Add skills menu adds a repository, uploads
// skills or opens a dialog to write one. Each repository is a row; skills uploaded or written here
// form a group of their own once there are any, each opening a dialog to change or delete it. In a
// space, the org's repositories and skills carry a lock and the space's own switch, as the org's
// MCP servers do; the space's own are tagged as such. Only those who manage a scope change it;
// others read it.

import { EmptyState } from "@/web/components/page-states";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  GitBranchIcon,
  PencilLineIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  type SkillSourceSummary,
  type SkillSummary,
  type SpaceOrgSkill,
  type SpaceOrgSource,
} from "@/shared/skills.ts";
import { SettingsCard } from "@/web/shell/settings-page";
import { useOpenSections } from "@/web/agent/open-sections";
import { RowBadge, SettingsRow } from "@/web/shell/settings-row";
import { ScopedSwitch } from "@/web/shell/scoped-switch";
import { SettingsSwitch } from "@/web/shell/settings-switch";
import { Alert, AlertDescription } from "@/web/components/ui/alert";
import { HeaderAction } from "@/web/shell/people-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { Spinner } from "@/web/components/ui/spinner";
import { apiClient } from "@/web/api/api-client";
import type { Scope } from "@/web/shell/scope";
import { SkillLine, SourceRow, inSpaceOf, refOf, shortCommit } from "@/web/skills/source-row";
import { useChange } from "@/web/skills/mutations";
import { useUpload } from "@/web/skills/upload";
import { AddRepositoryDialog } from "@/web/skills/add-repository-dialog";
import { SkillPreviewDialog } from "@/web/skills/preview-dialog";
import { type Draft, WrittenDialog } from "@/web/skills/written-dialog";

// The open state of the written skills' group, beside the repositories'.
const WRITTEN = "skills:written";

function sourceLine(source: SkillSourceSummary) {
  if (source.builtin) return source.label;
  const path = source.subpath ? `/${source.subpath}` : "";
  return `${source.label}${path} · ${refOf(source)} @ ${shortCommit(source.commit)}`;
}

type SourceEntry = { source: SkillSourceSummary | SpaceOrgSource; locked: boolean };

export type WrittenRow = { skill: SkillSummary | SpaceOrgSkill; locked: boolean };

export function SkillsCard({
  scope,
  state,
  sources,
  written,
  canManage,
  allowed,
  spaceSkills,
}: {
  scope: Scope;
  state: { isPending: boolean; error: Error | null };
  sources: SourceEntry[];
  written: WrittenRow[];
  canManage: boolean;
  // Whether the scope may add skills and the agent uses them: a space's only while the org lets
  // spaces have them.
  allowed: boolean;
  // For the org, whether its spaces may add their own.
  spaceSkills: boolean | null;
}) {
  const sections = useOpenSections(scope.kind);
  const [adding, setAdding] = useState<"repository" | "skill" | null>(null);
  const [previewing, setPreviewing] = useState<{
    skill: SkillSummary;
    source: SkillSourceSummary;
  } | null>(null);
  const [editing, setEditing] = useState<WrittenRow | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const {
    upload,
    uploading,
    error: uploadError,
  } = useUpload(scope, (next) => {
    setDraft(next);
    setAdding("skill");
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const own = sources.some((entry) => !entry.locked) || written.some((row) => !row.locked);
  return (
    <SettingsCard
      title="Skills"
      description="Instructions the agent loads when a task needs them."
      state={state}
      action={
        canManage && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <HeaderAction
                    icon={uploading ? <Spinner /> : <PlusIcon />}
                    label="Add skills"
                    disabled={!allowed || uploading}
                  >
                    <ChevronDownIcon />
                  </HeaderAction>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem onClick={() => setAdding("repository")}>
                  <GitBranchIcon />
                  Add repository
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => fileInput.current?.click()}>
                  <UploadIcon />
                  Upload skill
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAdding("skill")}>
                  <PencilLineIcon />
                  New skill
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={fileInput}
              type="file"
              aria-label="Skill file"
              accept=".md,.markdown,.zip,text/markdown,application/zip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) upload(file);
              }}
            />
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {uploadError && <FieldError>{uploadError}</FieldError>}
        {!allowed && own && (
          <Alert>
            <CircleAlertIcon />
            <AlertDescription>
              The organization doesn't let spaces add skills, so this space's own are not used.
            </AlertDescription>
          </Alert>
        )}
        {sources.length > 0 || written.length > 0 ? (
          <div className="-my-3 flex flex-col divide-y">
            {sources.map(({ source, locked }) => (
              <SourceRow
                key={source.id}
                scope={scope}
                source={source}
                locked={locked}
                canManage={canManage}
                open={sections.isOpen(source.id)}
                onOpenChange={(open) => sections.set(source.id, open)}
                onPreview={(skill) => setPreviewing({ skill, source })}
              />
            ))}
            {written.length > 0 && (
              <WrittenGroup
                scope={scope}
                rows={written}
                canManage={canManage}
                open={sections.isOpen(WRITTEN)}
                onOpenChange={(open) => sections.set(WRITTEN, open)}
                onOpen={setEditing}
              />
            )}
          </div>
        ) : (
          <EmptyState compact title="No skills yet" />
        )}
        {spaceSkills !== null && <SpaceSkillsSwitch allowed={spaceSkills} canManage={canManage} />}
      </div>
      {adding === "repository" && (
        <AddRepositoryDialog
          scope={scope}
          onClose={() => setAdding(null)}
          onAdded={(id) => sections.set(id, true)}
        />
      )}
      {(adding === "skill" || editing) && (
        <WrittenDialog
          scope={scope}
          row={editing}
          initial={draft ?? undefined}
          readOnly={!!editing && (editing.locked || !canManage)}
          onClose={() => {
            setAdding(null);
            setEditing(null);
            setDraft(null);
          }}
        />
      )}
      {previewing && (
        <SkillPreviewDialog
          skill={previewing.skill}
          line={sourceLine(previewing.source)}
          onClose={() => setPreviewing(null)}
        />
      )}
    </SettingsCard>
  );
}

// The skills written by hand, as one group; in a space, the org's tagged and locked.
function WrittenGroup({
  scope,
  rows,
  canManage,
  open,
  onOpenChange,
  onOpen,
}: {
  scope: Scope;
  rows: WrittenRow[];
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (row: WrittenRow) => void;
}) {
  const { error, pending, run } = useChange();
  const on = (row: WrittenRow) => row.skill.enabled && (!row.locked || inSpaceOf(row.skill));

  function switchSkill({ skill, locked }: WrittenRow, enabled: boolean) {
    void run(() =>
      locked && scope.kind === "space"
        ? apiClient.v1.spaces[":id"].skills[":skillId"].$put({
            param: { id: scope.spaceId, skillId: skill.id },
            json: { enabled },
          })
        : apiClient.v1.skills[":id"].enabled.$put({ param: { id: skill.id }, json: { enabled } }),
    );
  }

  return (
    <SettingsRow
      title="Written and uploaded"
      meta={
        <span>
          {rows.filter(on).length} of {rows.length} on
        </span>
      }
      open={open}
      onOpenChange={onOpenChange}
      control={
        error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )
      }
    >
      <ul className="flex flex-col">
        {rows.map((row) => (
          <SkillLine
            key={row.skill.id}
            skill={row.skill}
            tag={
              scope.kind === "space" &&
              (row.locked ? <RowBadge>Organization</RowBadge> : <RowBadge>This space</RowBadge>)
            }
            onOpen={() => onOpen(row)}
            control={
              <ScopedSwitch
                label={row.skill.name}
                inSpace={row.locked}
                here
                orgOff={row.locked && !row.skill.enabled}
                checked={row.locked ? row.skill.enabled && inSpaceOf(row.skill) : row.skill.enabled}
                disabled={!canManage || (row.locked && !row.skill.enabled) || pending}
                onCheckedChange={(enabled) => switchSkill(row, enabled)}
              />
            }
          />
        ))}
      </ul>
    </SettingsRow>
  );
}

function SpaceSkillsSwitch({ allowed, canManage }: { allowed: boolean; canManage: boolean }) {
  const { error, pending, run } = useChange();
  return (
    <SettingsSwitch
      label="Spaces can add their own skills"
      description="Those who manage a space add skills only its threads use."
      checked={allowed}
      disabled={!canManage || pending}
      error={error}
      className="border-t pt-4"
      onChange={(next) =>
        void run(() => apiClient.v1.org.skills["space-skills"].$put({ json: { allowed: next } }))
      }
    />
  );
}
