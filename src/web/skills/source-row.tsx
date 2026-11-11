// A skills repository as a collapsible row like a toolset's, with its branch and commit, how many
// of its skills are on, a switch, and a menu to refresh it (applied at once), change its token or
// remove it (a built-in one only has the switches); inside, its skills with their switches, each opening a read-only preview of its
// files.

import { type ReactNode, useState } from "react";

import {
  type SkillSourceSummary,
  type SkillSummary,
  type SpaceOrgSkill,
  type SpaceOrgSource,
  skillRefreshSchema,
} from "@/shared/skills.ts";
import { RowBadge, SettingsRow } from "@/web/shell/settings-row";
import { ScopedSwitch } from "@/web/shell/scoped-switch";
import { Time } from "@/web/components/time";
import { useToast } from "@/web/shell/toaster";
import { MoreMenu } from "@/web/components/more-menu";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import { Spinner } from "@/web/components/ui/spinner";
import { apiClient } from "@/web/api/api-client";
import type { Scope } from "@/web/shell/scope";
import { plural } from "@/web/lib/plural";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { useChange } from "@/web/skills/mutations";
import { TokenDialog } from "@/web/skills/token-dialog";

export function shortCommit(commit: string) {
  return commit.slice(0, 7);
}

export function refOf(source: Pick<SkillSourceSummary, "resolvedRef" | "ref">) {
  return source.resolvedRef ?? source.ref ?? "HEAD";
}

// One skill on one line: its name and description, opening it on click, and its switch.
export function SkillLine({
  skill,
  tag,
  onOpen,
  control,
}: {
  skill: SkillSummary;
  tag?: ReactNode;
  onOpen: () => void;
  control: ReactNode;
}) {
  return (
    <li aria-label={skill.name} className="flex min-h-12 items-center justify-between gap-3">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onOpen}
      >
        <span className="flex items-center gap-2 truncate text-sm">
          {skill.name}
          {tag}
        </span>
        <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
      </button>
      {control}
    </li>
  );
}

export function SourceRow({
  scope,
  source,
  locked,
  canManage,
  open,
  onOpenChange,
  onPreview,
}: {
  scope: Scope;
  source: SkillSourceSummary | SpaceOrgSource;
  locked: boolean;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (skill: SkillSummary) => void;
}) {
  const toast = useToast();
  const { error, pending, run } = useChange();
  const [dialog, setDialog] = useState<"token" | "remove" | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sourceOn = locked ? source.enabled && inSpaceOf(source) : source.enabled;
  const skillOn = (skill: SkillSummary) =>
    sourceOn && (locked ? skill.enabled && inSpaceOf(skill) : skill.enabled);
  const onCount = source.skills.filter(skillOn).length;

  function switchSource(enabled: boolean) {
    void run(() =>
      locked && scope.kind === "space"
        ? apiClient.v1.spaces[":id"]["skill-sources"][":sourceId"].$put({
            param: { id: scope.spaceId, sourceId: source.id },
            json: { enabled },
          })
        : apiClient.v1["skill-sources"][":id"].enabled.$put({
            param: { id: source.id },
            json: { enabled },
          }),
    );
  }

  function switchSkill(skill: SkillSummary, enabled: boolean) {
    void run(() =>
      locked && scope.kind === "space"
        ? apiClient.v1.spaces[":id"].skills[":skillId"].$put({
            param: { id: scope.spaceId, skillId: skill.id },
            json: { enabled },
          })
        : apiClient.v1.skills[":id"].enabled.$put({ param: { id: skill.id }, json: { enabled } }),
    );
  }

  // Reads the branch again and applies it, saying what changed.
  async function refresh() {
    setRefreshing(true);
    const res = await run(() =>
      apiClient.v1["skill-sources"][":id"].refresh.$post({ param: { id: source.id } }),
    );
    setRefreshing(false);
    if (!res) return;
    const { added, changed, removed } = skillRefreshSchema.parse(await res.json());
    const parts = [
      added.length && `${added.length} new`,
      changed.length && `${changed.length} changed`,
      removed.length && `${removed.length} removed`,
    ].filter(Boolean);
    toast(parts.length ? `Refreshed: ${parts.join(", ")}` : "Up to date", "info");
  }

  return (
    <>
      <SettingsRow
        title={`${source.label}${source.subpath ? `/${source.subpath}` : ""}`}
        badge={
          <>
            {scope.kind === "space" && !locked && <RowBadge>This space</RowBadge>}
            {source.hasToken && <RowBadge>Token</RowBadge>}
          </>
        }
        meta={
          <>
            {!source.builtin && (
              <span className="hidden font-mono sm:inline">
                {refOf(source)} @ {shortCommit(source.commit)}
              </span>
            )}
            <span>
              {onCount} of {source.skills.length} on
            </span>
          </>
        }
        open={open}
        onOpenChange={onOpenChange}
        on={sourceOn}
        control={
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {refreshing && (
              <span role="status" className="flex items-center gap-1">
                <Spinner />
                Refreshing…
              </span>
            )}
            {error && (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            )}
            <ScopedSwitch
              label={source.label}
              inSpace={locked}
              here
              orgOff={locked && !source.enabled}
              checked={locked ? source.enabled && inSpaceOf(source) : source.enabled}
              disabled={!canManage || (locked && !source.enabled) || pending}
              onCheckedChange={switchSource}
            />
            {!locked && canManage && !source.builtin && (
              <MoreMenu
                name={source.label}
                destructive={
                  <DropdownMenuItem variant="destructive" onClick={() => setDialog("remove")}>
                    Remove
                  </DropdownMenuItem>
                }
              >
                <DropdownMenuItem disabled={refreshing} onClick={() => void refresh()}>
                  Refresh
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog("token")}>
                  {source.hasToken ? "Change token" : "Add a token"}
                </DropdownMenuItem>
              </MoreMenu>
            )}
          </span>
        }
      >
        {!source.builtin && (
          <p className="pt-1 text-xs text-muted-foreground">
            Read <Time iso={source.fetchedAt} />
          </p>
        )}
        <ul className="flex flex-col">
          {source.skills.map((skill) => (
            <SkillLine
              key={skill.id}
              skill={skill}
              onOpen={() => onPreview(skill)}
              control={
                <ScopedSwitch
                  label={skill.name}
                  inSpace={locked}
                  here
                  orgOff={locked && !(skill.enabled && source.enabled)}
                  checked={
                    locked ? skill.enabled && source.enabled && inSpaceOf(skill) : skill.enabled
                  }
                  disabled={!canManage || (locked && !(skill.enabled && source.enabled)) || pending}
                  onCheckedChange={(enabled) => switchSkill(skill, enabled)}
                />
              }
            />
          ))}
        </ul>
      </SettingsRow>
      {dialog === "token" && <TokenDialog source={source} onClose={() => setDialog(null)} />}
      {dialog === "remove" && (
        <RemoveDialog scope={scope} source={source} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

export function inSpaceOf(item: SkillSummary | SkillSourceSummary) {
  return "inSpace" in item ? (item as SpaceOrgSkill).inSpace : true;
}

function RemoveDialog({
  scope,
  source,
  onClose,
}: {
  scope: Scope;
  source: SkillSourceSummary;
  onClose: () => void;
}) {
  const { error, pending, run } = useChange();
  const on = source.skills.filter((skill) => skill.enabled).length;

  async function remove() {
    const res = await run(() =>
      apiClient.v1["skill-sources"][":id"].$delete({ param: { id: source.id } }),
    );
    if (res) onClose();
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Remove ${source.label}?`}
      description={
        <>
          Its {plural(source.skills.length, "skill")} ({on} on) go from{" "}
          {scope.kind === "org" ? "every space" : "this space"}.
        </>
      }
      error={error}
      action="Remove"
      disabled={pending}
      onConfirm={() => void remove()}
    />
  );
}
