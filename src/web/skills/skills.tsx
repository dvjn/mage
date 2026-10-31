// The agent's skills in settings, on a page of their own for the org and for a space. The card
// works like the MCP servers card: an Add skills menu adds a repository whole from a dialog that
// takes owner/repo, a git address or a command that adds skills, and asks for a token when the
// repository is private, every skill in it arriving off; uploads a SKILL.md or a zip of skill
// folders; or opens a dialog to write one. Each repository is a collapsible row like a toolset's,
// with its branch and commit, how many of its skills are on, a switch, and a menu to refresh it
// (applied at once), change its token or remove it; inside, its skills with their switches, each
// opening a read-only preview of its files. Skills uploaded or written here form a group of their
// own once there are any, each opening a dialog to change or delete it. In a space, the org's
// repositories and skills carry a lock and the space's own switch, as the org's MCP servers do;
// the space's own are tagged as such. Only those who manage a scope change it; others read it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  GitBranchIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";

import {
  SKILL_NAME,
  type SkillSourceSummary,
  type SkillSummary,
  type SpaceOrgSkill,
  type SpaceOrgSource,
  skillRefreshSchema,
  skillSourceSchema,
  skillUploadResultSchema,
  UPLOAD_MAX_BYTES,
} from "@/shared/skills.ts";
import { SettingsCard, SettingsTitle } from "@/web/settings/layout";
import { ToolsetSection, useOpenSections } from "@/web/agent/tools-list";
import { Time } from "@/web/components/time";
import { useToast } from "@/web/app/toaster";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/web/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/web/components/ui/alert";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogClose,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Spinner } from "@/web/components/ui/spinner";
import { Switch } from "@/web/components/ui/switch";
import { Textarea } from "@/web/components/ui/textarea";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { meQuery } from "@/web/auth/queries";
import { orgSkillsQuery, skillQuery, spaceSkillsQuery } from "@/web/skills/queries";

// Whose settings: the org's, or one space's.
export type AgentScope = { kind: "org" } | { kind: "space"; spaceId: string };

// The open state of the written skills' group, beside the repositories'.
const WRITTEN = "skills:written";

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function shortCommit(commit: string) {
  return commit.slice(0, 7);
}

function refOf(source: Pick<SkillSourceSummary, "resolvedRef" | "ref">) {
  return source.resolvedRef ?? source.ref ?? "HEAD";
}

function sourceLine(source: SkillSourceSummary) {
  const path = source.subpath ? `/${source.subpath}` : "";
  return `${source.label}${path} · ${refOf(source)} @ ${shortCommit(source.commit)}`;
}

// Runs a change and reads the skills again, keeping what went wrong.
function useChange() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  async function run(send: () => Promise<Response>) {
    setError(undefined);
    const res = await send();
    if (!res.ok) {
      setError(await errorOf(res));
      return null;
    }
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    return res;
  }
  return { error, setError, run };
}

// The org's Skills page.
export function OrgSkills() {
  const me = useQuery(meQuery);
  const canManage = me.data?.role === "owner";
  const agent = useQuery(orgSkillsQuery);
  const data = agent.data;
  return (
    <>
      <SettingsTitle
        title="Skills"
        description={
          canManage
            ? "What the agent can load in every space."
            : "What the agent can load in every space. Only the organization's owners change this."
        }
      />
      <SkillsCard
        scope={{ kind: "org" }}
        state={agent}
        sources={(data?.sources ?? []).map((source) => ({ source, locked: false }))}
        written={(data?.written ?? []).map((skill) => ({ skill, locked: false }))}
        canManage={canManage}
        allowed
        spaceSkills={data?.spaceSkills ?? null}
      />
    </>
  );
}

// A space's Skills page: the org's, with the space's switches, and its own.
export function SpaceSkills({ spaceId }: { spaceId: string }) {
  const agent = useQuery(spaceSkillsQuery(spaceId));
  const data = agent.data;
  return (
    <>
      <SettingsTitle title="Skills" description="What the agent can load in this space." />
      <SkillsCard
        scope={{ kind: "space", spaceId }}
        state={agent}
        sources={[
          ...(data?.org.sources ?? []).map((source) => ({ source, locked: true })),
          ...(data?.own.sources ?? []).map((source) => ({ source, locked: false })),
        ]}
        written={[
          ...(data?.org.written ?? []).map((skill) => ({ skill, locked: true })),
          ...(data?.own.written ?? []).map((skill) => ({ skill, locked: false })),
        ]}
        canManage
        allowed={data?.allowed ?? true}
        spaceSkills={null}
      />
    </>
  );
}

type SourceEntry = { source: SkillSourceSummary | SpaceOrgSource; locked: boolean };
type WrittenRow = { skill: SkillSummary | SpaceOrgSkill; locked: boolean };

function SkillsCard({
  scope,
  state,
  sources,
  written,
  canManage,
  allowed,
  spaceSkills,
}: {
  scope: AgentScope;
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
                render={<Button variant="outline" size="sm" disabled={!allowed || uploading} />}
              >
                {uploading ? <Spinner /> : <PlusIcon />}
                Add skills
                <ChevronDownIcon />
              </DropdownMenuTrigger>
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
                if (file) void upload(file);
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
          <p className="text-sm text-muted-foreground">No skills yet</p>
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

// Uploads a SKILL.md or a zip of skills; a file that does not name or describe its skill opens the
// new skill dialog with what it holds.
function useUpload(scope: AgentScope, onDraft: (draft: Draft) => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  async function upload(file: File) {
    setError(undefined);
    if (file.size > UPLOAD_MAX_BYTES) {
      setError("This file is too large");
      return;
    }
    setUploading(true);
    const json = { fileName: file.name, data: base64Of(new Uint8Array(await file.arrayBuffer())) };
    const res =
      scope.kind === "org"
        ? await apiClient.v1.org.skills.upload.$post({ json })
        : await apiClient.v1.spaces[":id"].skills.upload.$post({
            param: { id: scope.spaceId },
            json,
          });
    setUploading(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const result = skillUploadResultSchema.parse(await res.json());
    if (result.status === "draft") {
      onDraft(result.draft);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    const [first] = result.skills;
    toast(
      result.skills.length === 1 && first
        ? `Added ${first.name}${first.enabled ? "" : ", off"}`
        : `Added ${plural(result.skills.length, "skill")}, off`,
      "info",
    );
  }

  return { upload, uploading, error };
}

function base64Of(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

// Adds a repository whole, from what people paste; a private one asks for a token and tries again.
function AddRepositoryDialog({
  scope,
  onClose,
  onAdded,
}: {
  scope: AgentScope;
  onClose: () => void;
  onAdded: (sourceId: string) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [token, setToken] = useState("");
  const [asksToken, setAsksToken] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const json = { input, ...(token.trim() && { token: token.trim() }) };
    const res =
      scope.kind === "org"
        ? await apiClient.v1.org["skill-sources"].$post({ json })
        : await apiClient.v1.spaces[":id"]["skill-sources"].$post({
            param: { id: scope.spaceId },
            json,
          });
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        reason?: string;
      } | null;
      setError(body?.error ?? "Something went wrong. Try again.");
      if (body?.reason === "auth" || body?.reason === "not_found") setAsksToken(true);
      return;
    }
    const source = skillSourceSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    onAdded(source.id);
    toast(`Added ${plural(source.skills.length, "skill")}, off`, "info");
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-input`}>Repository</FieldLabel>
              <Input
                id={`${id}-input`}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="owner/repo or git URL"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono"
              />
            </Field>
            {asksToken && (
              <Field>
                <FieldLabel htmlFor={`${id}-token`}>Token</FieldLabel>
                <Input
                  id={`${id}-token`}
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Read access"
                  autoComplete="off"
                  autoFocus
                />
                <FieldDescription>Never shown again.</FieldDescription>
              </Field>
            )}
            {pending ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Fetching…
              </p>
            ) : (
              <FieldError>{error}</FieldError>
            )}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending || !input.trim()}>
              Add repository
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function badge(text: string) {
  return (
    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
      {text}
    </Badge>
  );
}

// One skill on one line: its name and description, opening it on click, and its switch.
function SkillLine({
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

function SourceRow({
  scope,
  source,
  locked,
  canManage,
  open,
  onOpenChange,
  onPreview,
}: {
  scope: AgentScope;
  source: SkillSourceSummary | SpaceOrgSource;
  locked: boolean;
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (skill: SkillSummary) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { error, setError, run } = useChange();
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
    setError(undefined);
    setRefreshing(true);
    const res = await apiClient.v1["skill-sources"][":id"].refresh.$post({
      param: { id: source.id },
    });
    setRefreshing(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const { added, changed, removed } = skillRefreshSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    const parts = [
      added.length && `${added.length} new`,
      changed.length && `${changed.length} changed`,
      removed.length && `${removed.length} removed`,
    ].filter(Boolean);
    toast(parts.length ? `Refreshed: ${parts.join(", ")}` : "Up to date", "info");
  }

  return (
    <>
      <ToolsetSection
        title={`${source.label}${source.subpath ? `/${source.subpath}` : ""}`}
        badge={
          <>
            {scope.kind === "space" && !locked && badge("This space")}
            {source.hasToken && badge("Token")}
          </>
        }
        count={null}
        counts={
          <>
            <span className="hidden font-mono sm:inline">
              {refOf(source)} @ {shortCommit(source.commit)}
            </span>
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
              locked={locked}
              orgOn={source.enabled}
              on={locked ? inSpaceOf(source) : source.enabled}
              canManage={canManage}
              onChange={switchSource}
            />
            {!locked && canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`More for ${source.label}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem disabled={refreshing} onClick={() => void refresh()}>
                    Refresh
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDialog("token")}>
                    {source.hasToken ? "Change token" : "Add a token"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDialog("remove")}>
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        }
      >
        <p className="pt-1 text-xs text-muted-foreground">
          Read <Time iso={source.fetchedAt} />
        </p>
        <ul className="flex flex-col">
          {source.skills.map((skill) => (
            <SkillLine
              key={skill.id}
              skill={skill}
              onOpen={() => onPreview(skill)}
              control={
                <ScopedSwitch
                  label={skill.name}
                  locked={locked}
                  orgOn={skill.enabled && source.enabled}
                  on={locked ? inSpaceOf(skill) : skill.enabled}
                  canManage={canManage}
                  onChange={(enabled) => switchSkill(skill, enabled)}
                />
              }
            />
          ))}
        </ul>
      </ToolsetSection>
      {dialog === "token" && <TokenDialog source={source} onClose={() => setDialog(null)} />}
      {dialog === "remove" && (
        <RemoveDialog scope={scope} source={source} onClose={() => setDialog(null)} />
      )}
    </>
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
  scope: AgentScope;
  rows: WrittenRow[];
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (row: WrittenRow) => void;
}) {
  const { error, run } = useChange();
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
    <ToolsetSection
      title="Written and uploaded"
      count={null}
      counts={
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
              scope.kind === "space" && (row.locked ? badge("Organization") : badge("This space"))
            }
            onOpen={() => onOpen(row)}
            control={
              <ScopedSwitch
                label={row.skill.name}
                locked={row.locked}
                orgOn={row.skill.enabled}
                on={row.locked ? inSpaceOf(row.skill) : row.skill.enabled}
                canManage={canManage}
                onChange={(enabled) => switchSkill(row, enabled)}
              />
            }
          />
        ))}
      </ul>
    </ToolsetSection>
  );
}

// A switch with its words: On or Off for what the scope owns; for the org's in a space, On here or
// Off here, or Off by organization while the org has it off.
function ScopedSwitch({
  label,
  locked,
  orgOn,
  on,
  canManage,
  onChange,
}: {
  label: string;
  locked: boolean;
  orgOn: boolean;
  on: boolean;
  canManage: boolean;
  onChange: (on: boolean) => void;
}) {
  const words = locked
    ? orgOn
      ? on
        ? "On here"
        : "Off here"
      : "Off by organization"
    : on
      ? "On"
      : "Off";
  return (
    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {locked && (
        <WithTooltip label="Managed by the organization">
          <LockIcon className="size-3.5" aria-hidden />
        </WithTooltip>
      )}
      {words}
      <Switch
        size="sm"
        aria-label={`${label}: ${locked ? "on in this space" : "on"}`}
        checked={locked ? orgOn && on : on}
        disabled={!canManage || (locked && !orgOn)}
        onCheckedChange={onChange}
      />
    </label>
  );
}

function inSpaceOf(item: SkillSummary | SkillSourceSummary) {
  return "inSpace" in item ? (item as SpaceOrgSkill).inSpace : true;
}

function TokenDialog({ source, onClose }: { source: SkillSourceSummary; onClose: () => void }) {
  const id = useId();
  const toast = useToast();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const { error, run } = useChange();

  async function save(next: string | null) {
    setPending(true);
    const res = await run(() =>
      apiClient.v1["skill-sources"][":id"].token.$put({
        param: { id: source.id },
        json: { token: next },
      }),
    );
    setPending(false);
    if (!res) return;
    toast(next ? "Token saved" : "Token removed", "info");
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{source.hasToken ? "Change token" : "Add a token"}</DialogTitle>
          <DialogDescription>Never shown again.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(token.trim());
          }}
        >
          <Field>
            <FieldLabel htmlFor={id}>Personal access token</FieldLabel>
            <Input
              id={id}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={source.hasToken ? "New token" : "Read access"}
              autoComplete="off"
              autoFocus
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter className="mt-4">
            {source.hasToken && (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                disabled={pending}
                onClick={() => void save(null)}
              >
                Remove token
              </Button>
            )}
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending || !token.trim()}>
              Save and fetch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  scope,
  source,
  onClose,
}: {
  scope: AgentScope;
  source: SkillSourceSummary;
  onClose: () => void;
}) {
  const { error, run } = useChange();
  const on = source.skills.filter((skill) => skill.enabled).length;

  async function remove() {
    const res = await run(() =>
      apiClient.v1["skill-sources"][":id"].$delete({ param: { id: source.id } }),
    );
    if (res) onClose();
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {source.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its {plural(source.skills.length, "skill")} ({on} on) go from{" "}
            {scope.kind === "org" ? "every space" : "this space"}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FieldError>{error}</FieldError>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void remove()}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// A skill's files, read-only: SKILL.md and what comes with it, scripts marked as never run.
function SkillPreviewDialog({
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
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
      </DialogContent>
    </Dialog>
  );
}

type Draft = { name: string; description: string; body: string };

// A skill written or uploaded here, to change or delete; or a new one, from scratch or from an
// uploaded file that did not name or describe it. One with files previews them.
function WrittenDialog({
  scope,
  row,
  initial,
  readOnly,
  onClose,
}: {
  scope: AgentScope;
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
  const [pending, setPending] = useState(false);
  const { error, run } = useChange();
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
    setPending(true);
    const json = loaded;
    const res = await run(() =>
      row
        ? apiClient.v1.skills[":id"].$patch({ param: { id: row.skill.id }, json })
        : scope.kind === "org"
          ? apiClient.v1.org.skills.$post({ json })
          : apiClient.v1.spaces[":id"].skills.$post({ param: { id: scope.spaceId }, json }),
    );
    setPending(false);
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
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
      </DialogContent>
    </Dialog>
  );
}

function SpaceSkillsSwitch({ allowed, canManage }: { allowed: boolean; canManage: boolean }) {
  const id = useId();
  const { error, run } = useChange();
  return (
    <Field orientation="horizontal" className="border-t pt-4">
      <FieldContent>
        <FieldLabel htmlFor={id}>Spaces can add their own skills</FieldLabel>
        <FieldDescription>
          Those who manage a space add skills only its threads use.
        </FieldDescription>
        <FieldError>{error}</FieldError>
      </FieldContent>
      <Switch
        id={id}
        checked={allowed}
        disabled={!canManage}
        onCheckedChange={(next) =>
          void run(() => apiClient.v1.org.skills["space-skills"].$put({ json: { allowed: next } }))
        }
      />
    </Field>
  );
}
