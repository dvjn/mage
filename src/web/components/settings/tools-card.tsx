// The agent's tools in settings, one collapsible section per toolset, its tools split into read-only
// and interactive ones. Each group sets all its tools at once; each tool is allowed, asks every
// time, or is blocked. For the org, only its owners change them; for a space, a tool can only be
// made stricter than the org has it. Which sections are open is remembered in this browser for the
// signed-in person.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { BanIcon, ChevronRightIcon, CircleCheckIcon, HandIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  strictest,
  type ToolMode,
  type ToolSetting,
  type ToolsetSetting,
  toolsetSettingListSchema,
} from "@/shared/tools.ts";
import { SettingsCard } from "@/web/components/settings/layout";
import { Badge } from "@/web/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { FieldError } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/web/components/ui/toggle-group";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { meQuery } from "@/web/lib/queries";

const orgToolsKey = ["org-tools"];

function spaceToolsKey(spaceId: string) {
  return ["spaces", spaceId, "tools"];
}

const MODES: { value: ToolMode; label: string; icon: ReactNode; tone: string }[] = [
  {
    value: "allow",
    label: "Always allow",
    icon: <CircleCheckIcon />,
    tone: "aria-pressed:text-foreground",
  },
  {
    value: "ask",
    label: "Needs approval",
    icon: <HandIcon />,
    tone: "aria-pressed:text-status-waiting",
  },
  { value: "block", label: "Blocked", icon: <BanIcon />, tone: "aria-pressed:text-destructive" },
];

const LABELS = Object.fromEntries(MODES.map((mode) => [mode.value, mode.label])) as Record<
  ToolMode,
  string
>;

const SOURCES: Record<ToolsetSetting["source"], string> = { builtin: "Built in", mcp: "MCP" };

const SET_BY_ORG = "Set by the organization";

// A toolset with more tools than this gets a filter.
const FILTER_FROM = 8;

// Whether the mode lets more through than the other.
function looser(mode: ToolMode, than: ToolMode) {
  return mode !== than && strictest(mode, than) === than;
}

// A tool's title, or its name where it has none.
function labelOf(tool: ToolSetting) {
  return tool.definition.title ?? tool.definition.name;
}

// Which sections the person has open, kept in this browser; a section never toggled is open as
// the card says by default.
function useOpenSections(scope: "org" | "space") {
  const userId = useQuery(meQuery).data?.user.id ?? "";
  const key = `mage:tool-sections:${userId}:${scope}`;
  const [kept, setKept] = useState(() => ({ key, open: storedSections(key) }));
  // The person is known only once the app has read who they are; read their sections then.
  if (kept.key !== key) setKept({ key, open: storedSections(key) });
  const open = kept.key === key ? kept.open : storedSections(key);
  return {
    isOpen: (id: string, fallback: boolean) => open[id] ?? fallback,
    set(id: string, next: boolean) {
      const all = { ...open, [id]: next };
      setKept({ key, open: all });
      try {
        localStorage.setItem(key, JSON.stringify(all));
      } catch {
        // Storage can be unavailable; the sections then open as they do by default.
      }
    },
  };
}

function storedSections(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

type Change = (toolIds: string[], mode: ToolMode) => void;

interface ToolsProps {
  toolsets: ToolsetSetting[];
  scope: "org" | "space";
  canChange: boolean;
  onChange: Change;
}

function Toolsets({ toolsets, scope, canChange, onChange }: ToolsProps) {
  const sections = useOpenSections(scope);
  return (
    <div className="flex flex-col divide-y border-y">
      {toolsets.map((toolset) => (
        <ToolsetSection
          key={toolset.id}
          toolset={toolset}
          open={sections.isOpen(toolset.id, toolsets.length === 1)}
          onOpenChange={(open) => sections.set(toolset.id, open)}
          groupOpen={(id) => sections.isOpen(`${toolset.id}/${id}`, true)}
          onGroupOpenChange={(id, open) => sections.set(`${toolset.id}/${id}`, open)}
          scope={scope}
          canChange={canChange}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function Chevron() {
  return (
    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
  );
}

function ToolsetSection({
  toolset,
  open,
  onOpenChange,
  groupOpen,
  onGroupOpenChange,
  scope,
  canChange,
  onChange,
}: {
  toolset: ToolsetSetting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupOpen: (id: string) => boolean;
  onGroupOpenChange: (id: string, open: boolean) => void;
} & Omit<ToolsProps, "toolsets">) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = toolset.tools.filter((tool) =>
    [labelOf(tool), tool.definition.name, tool.definition.description ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
  const readOnly = (tool: ToolSetting) => tool.definition.annotations?.readOnlyHint === true;
  const groups = [
    { id: "read-only", name: "Read-only tools", tools: toolset.tools.filter(readOnly) },
    {
      id: "interactive",
      name: "Interactive tools",
      tools: toolset.tools.filter((tool) => !readOnly(tool)),
    },
  ].filter((group) => group.tools.length > 0);
  const count = toolset.tools.length;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<section aria-label={toolset.title} />}
    >
      <CollapsibleTrigger className="group/trigger flex w-full items-center gap-2 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <Chevron />
        <span className="text-sm font-medium">{toolset.title}</span>
        <Badge variant="secondary">{SOURCES[toolset.source]}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {count === 1 ? "1 tool" : `${count} tools`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col pb-2 pl-6">
        {count > FILTER_FROM && (
          <InputGroup className="mb-2">
            <InputGroupInput
              type="search"
              placeholder="Filter tools"
              aria-label={`Filter ${toolset.title} tools`}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        )}
        <div className="flex flex-col divide-y">
          {groups.map((group) => (
            <ToolGroup
              key={group.id}
              name={group.name}
              tools={group.tools}
              shown={group.tools.filter((tool) => shown.includes(tool))}
              open={needle ? true : groupOpen(group.id)}
              onOpenChange={(next) => onGroupOpenChange(group.id, next)}
              scope={scope}
              canChange={canChange}
              onChange={onChange}
            />
          ))}
        </div>
        {needle && shown.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">No matches</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolGroup({
  name,
  tools,
  shown,
  open,
  onOpenChange,
  scope,
  canChange,
  onChange,
}: {
  name: string;
  tools: ToolSetting[];
  shown: ToolSetting[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<ToolsProps, "toolsets">) {
  const modes = new Set(tools.map((tool) => tool.mode));
  const value = modes.size === 1 ? [...modes][0]! : "custom";
  // In a space, a mode no tool in the group may take there.
  const unavailable = (mode: ToolMode) =>
    scope === "space" && tools.every((tool) => looser(mode, tool.orgMode));
  if (shown.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<div role="group" aria-label={name} />}
    >
      <div className="flex items-center gap-2 py-2">
        <CollapsibleTrigger className="group/trigger flex flex-1 items-center gap-2 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Chevron />
          {name}
          <Badge variant="outline">{tools.length}</Badge>
        </CollapsibleTrigger>
        <Select
          value={value}
          disabled={!canChange}
          onValueChange={(next) =>
            next &&
            next !== "custom" &&
            onChange(
              tools.map((tool) => tool.id),
              next as ToolMode,
            )
          }
        >
          <SelectTrigger size="sm" aria-label={name} className="w-40">
            <SelectValue>{() => (value === "custom" ? "Custom" : LABELS[value])}</SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {MODES.map((mode) => (
              <SelectItem key={mode.value} value={mode.value} disabled={unavailable(mode.value)}>
                <span className="flex flex-col">
                  {mode.label}
                  {unavailable(mode.value) && (
                    <span className="text-xs text-muted-foreground">{SET_BY_ORG}</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <CollapsibleContent>
        <ul className="flex flex-col divide-y border-t pl-6">
          {shown.map((tool) => (
            <ToolRow
              key={tool.id}
              tool={tool}
              scope={scope}
              canChange={canChange}
              onChange={onChange}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolRow({
  tool,
  scope,
  canChange,
  onChange,
}: {
  tool: ToolSetting;
} & Omit<ToolsProps, "toolsets">) {
  const label = labelOf(tool);
  return (
    <li aria-label={label} className="flex items-center justify-between gap-4 py-2">
      <span className="flex min-w-0 flex-col">
        <span className="text-sm">{label}</span>
        {tool.definition.description && (
          <span className="text-xs text-muted-foreground">{tool.definition.description}</span>
        )}
      </span>
      <ToggleGroup
        aria-label={`${label}: when the agent may use it`}
        size="sm"
        spacing={0.5}
        value={[tool.mode]}
        disabled={!canChange}
        onValueChange={(next: string[]) => {
          const chosen = next.find((mode) => mode !== tool.mode);
          if (chosen) onChange([tool.id], chosen as ToolMode);
        }}
        className="shrink-0 rounded-lg border p-0.5"
      >
        {MODES.map((mode) => {
          const setByOrg = scope === "space" && looser(mode.value, tool.orgMode);
          const item = (
            <ToggleGroupItem
              value={mode.value}
              aria-label={mode.label}
              disabled={setByOrg}
              className={cn("text-muted-foreground", mode.tone)}
            >
              {mode.icon}
            </ToggleGroupItem>
          );
          return (
            <WithTooltip key={mode.value} label={setByOrg ? SET_BY_ORG : mode.label}>
              {/* A disabled control takes no pointer, so its wrapper holds the tooltip. */}
              {setByOrg ? <span className="inline-flex">{item}</span> : item}
            </WithTooltip>
          );
        })}
      </ToggleGroup>
    </li>
  );
}

export function OrgToolsCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const tools = useQuery({
    queryKey: orgToolsKey,
    queryFn: async () => {
      const res = await apiClient.v1.org.tools.$get();
      if (!res.ok) throw new Error("could not read the tools");
      return toolsetSettingListSchema.parse(await res.json());
    },
  });

  async function change(toolIds: string[], mode: ToolMode) {
    setError(undefined);
    const res = await apiClient.v1.org.tools.$patch({ json: { toolIds, mode } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(orgToolsKey, toolsetSettingListSchema.parse(await res.json()));
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  return (
    <SettingsCard
      title="Tools"
      description={
        canManage
          ? "What the agent can do in this organization's threads. Anyone who can message runs an allowed tool; a tool that needs approval asks each time. Spaces can only make these stricter."
          : "What the agent can do in this organization's threads. Only the organization's owners can change this."
      }
      state={tools}
    >
      {tools.data && (
        <Toolsets
          toolsets={tools.data}
          scope="org"
          canChange={canManage}
          onChange={(toolIds, mode) => void change(toolIds, mode)}
        />
      )}
      <FieldError>{error}</FieldError>
    </SettingsCard>
  );
}

export function SpaceToolsCard({ spaceId }: { spaceId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const tools = useQuery({
    queryKey: spaceToolsKey(spaceId),
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].tools.$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the tools");
      return toolsetSettingListSchema.parse(await res.json());
    },
  });

  async function change(toolIds: string[], mode: ToolMode) {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].tools.$patch({
      param: { id: spaceId },
      json: { toolIds, mode },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(
      spaceToolsKey(spaceId),
      toolsetSettingListSchema.parse(await res.json()),
    );
  }

  return (
    <SettingsCard
      title="Tools"
      description="What the agent can do in this space's threads. Anyone who can message runs an allowed tool, or decides when one needs approval. The organization sets the loosest each tool can be."
      state={tools}
    >
      {tools.data && (
        <Toolsets
          toolsets={tools.data}
          scope="space"
          canChange
          onChange={(toolIds, mode) => void change(toolIds, mode)}
        />
      )}
      <FieldError>{error}</FieldError>
    </SettingsCard>
  );
}
