// The agent's tools in settings, a card for each source of toolsets (built in, MCP servers) and in
// it one collapsible row per toolset with counts of its tools' modes and a built-in on/off switch.
// Inside, its tools are split under plain read-only and interactive headings. Each heading's icons
// set all its tools at once; each tool runs, asks, requires independent review, or is blocked. For the org,
// only its owners change them; for a space, a tool can only be made stricter than the org has it,
// but for the space's own toolsets. Which toolsets are open is remembered in this browser for the
// signed-in person. The toolsets an MCP server card shows are handed to it as they are read.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  BanIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  HandIcon,
  LockIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  strictest,
  type ToolMode,
  type ToolSetting,
  type ToolsetSetting,
  toolsetSettingListSchema,
} from "@/shared/tools.ts";
import { ListSkeleton, LoadError } from "@/web/components/page-states";
import { SettingsCard } from "@/web/components/settings/layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { FieldError } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/web/components/ui/toggle-group";
import { Switch } from "@/web/components/ui/switch";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { meQuery } from "@/web/lib/queries";

export const orgToolsKey = ["org-tools"];

export function spaceToolsKey(spaceId: string) {
  return ["spaces", spaceId, "tools"];
}

// Each mode, named for one tool, for a whole group and for a count of tools, with its colour when
// pressed and in a count.
const MODES: {
  value: ToolMode;
  label: string;
  all: string;
  counted: (count: number) => string;
  icon: ReactNode;
  tone: string;
  color: string;
}[] = [
  {
    value: "allow",
    label: "Always allow",
    all: "Allow all",
    counted: (count) => `${count} allowed`,
    icon: <CircleCheckIcon />,
    tone: "aria-pressed:text-foreground",
    color: "text-foreground",
  },
  {
    value: "ask",
    label: "Needs approval",
    all: "Ask for all",
    counted: (count) => `${count} ${count === 1 ? "needs" : "need"} approval`,
    icon: <HandIcon />,
    tone: "aria-pressed:text-tool-ask",
    color: "text-tool-ask",
  },
  {
    value: "review",
    label: "Require independent review",
    all: "Review all independently",
    counted: (count) => `${count} ${count === 1 ? "needs" : "need"} independent review`,
    icon: <ShieldCheckIcon />,
    tone: "aria-pressed:text-tool-ask",
    color: "text-tool-ask",
  },
  {
    value: "block",
    label: "Blocked",
    all: "Block all",
    counted: (count) => `${count} blocked`,
    icon: <BanIcon />,
    tone: "aria-pressed:text-destructive",
    color: "text-destructive",
  },
];

// Each source's card title, in the order the cards show.
const SOURCES: Record<ToolsetSetting["source"], string> = {
  builtin: "Built in",
  mcp: "MCP servers",
};

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

// Which toolsets the person has open, kept in this browser; a toolset never toggled is open as the
// list says by default.
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
        // Storage can be unavailable; the toolsets then open as they do by default.
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

export type Change = (toolIds: string[], mode: ToolMode) => void;

interface ToolsProps {
  toolsets: ToolsetSetting[];
  scope: "org" | "space";
  canChange: boolean;
  onChange: Change;
  onSwitch?: (toolsetId: string, enabled: boolean) => void;
}

function Toolsets({ toolsets, scope, canChange, onChange, onSwitch }: ToolsProps) {
  const sections = useOpenSections(scope);
  // A card only for a source that has toolsets.
  const sources = (Object.keys(SOURCES) as ToolsetSetting["source"][])
    .map((source) => ({ source, toolsets: toolsets.filter((t) => t.source === source) }))
    .filter((group) => group.toolsets.length > 0);
  return sources.map(({ source, toolsets: inSource }) => (
    <SettingsCard key={source} title={SOURCES[source]}>
      <div className="-my-3 flex flex-col divide-y">
        {inSource.map((toolset) => (
          <ToolsetSection
            key={toolset.id}
            toolset={toolset}
            open={sections.isOpen(toolset.id, toolsets.length === 1)}
            onOpenChange={(open) => sections.set(toolset.id, open)}
            scope={scope}
            canChange={canChange}
            onChange={onChange}
            onSwitch={onSwitch}
          />
        ))}
      </div>
    </SettingsCard>
  ));
}

// How many of the tools are in each mode: an icon and a number for each mode some tool is in.
export function ModeCounts({ tools }: { tools: ToolSetting[] }) {
  const counts = MODES.map((mode) => ({
    mode,
    count: tools.filter((tool) => tool.mode === mode.value).length,
  }));
  return (
    <span className="flex items-center gap-2.5">
      <span className="sr-only">
        {counts.map(({ mode, count }) => mode.counted(count)).join(", ")}
      </span>
      {counts
        .filter(({ count }) => count > 0)
        .map(({ mode, count }) => (
          <span
            key={mode.value}
            aria-hidden
            className={cn("flex items-center gap-1 tabular-nums [&_svg]:size-3.5", mode.color)}
          >
            {mode.icon}
            {count}
          </span>
        ))}
    </span>
  );
}

function ToolsetSection({
  toolset,
  open,
  onOpenChange,
  scope,
  canChange,
  onChange,
  onSwitch,
}: {
  toolset: ToolsetSetting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<ToolsProps, "toolsets">) {
  const count = toolset.tools.length;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<section aria-label={toolset.title} />}
    >
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger className="group/trigger flex w-full items-start gap-2 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="flex h-6 shrink-0 items-center">
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
            </span>
            {/* On a phone the counts go under the title. */}
            <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="truncate text-base leading-6 font-semibold">{toolset.title}</span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground sm:ml-auto">
                {count === 1 ? "1 tool" : `${count} tools`}
                <ModeCounts tools={toolset.tools} />
              </span>
            </span>
          </CollapsibleTrigger>
        </h2>
        {onSwitch && toolset.source === "builtin" && (
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {toolset.orgEnabled === false
              ? "Off by organization"
              : (toolset.enabled ?? true)
                ? "On"
                : "Off"}
            <Switch
              size="sm"
              aria-label={`${toolset.title}: ${scope === "space" ? "on in this space" : "on"}`}
              checked={toolset.enabled ?? true}
              disabled={!canChange || (scope === "space" && toolset.orgEnabled === false)}
              onCheckedChange={(enabled) => onSwitch(toolset.id, enabled)}
            />
          </label>
        )}
      </div>
      <CollapsibleContent className="mb-3 ml-[7px] border-l-2 pl-3 sm:pl-[15px]">
        <ToolsetTools toolset={toolset} scope={scope} canChange={canChange} onChange={onChange} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// A toolset's tools under their read-only and interactive headings, with a filter for many.
export function ToolsetTools({
  toolset,
  scope,
  canChange,
  onChange,
}: { toolset: ToolsetSetting } & Omit<ToolsProps, "toolsets">) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = toolset.tools.filter((tool) =>
    [labelOf(tool), tool.definition.name, tool.definition.description ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
  const readOnly = (tool: ToolSetting) => tool.definition.annotations?.readOnlyHint === true;
  const groups = [
    {
      id: "read-only",
      name: "Read-only tools",
      heading: "Read-only",
      tools: toolset.tools.filter(readOnly),
    },
    {
      id: "interactive",
      name: "Interactive tools",
      heading: "Interactive",
      tools: toolset.tools.filter((tool) => !readOnly(tool)),
    },
  ].filter((group) => group.tools.length > 0);
  // A space's own toolsets are not the org's to bound.
  const bounded = scope === "space" && toolset.scope === "org" ? "space" : "org";
  return (
    <div className="flex flex-col gap-1">
      {toolset.tools.length > FILTER_FROM && (
        <InputGroup className="mb-1">
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
      {groups.map((group) => (
        <ToolGroup
          key={group.id}
          name={group.name}
          heading={group.heading}
          tools={group.tools}
          shown={group.tools.filter((tool) => shown.includes(tool))}
          scope={bounded}
          canChange={canChange}
          onChange={onChange}
        />
      ))}
      {needle && shown.length === 0 && (
        <p className="py-2 text-sm text-muted-foreground">No matches</p>
      )}
    </div>
  );
}

function ToolGroup({
  name,
  heading,
  tools,
  shown,
  scope,
  canChange,
  onChange,
}: {
  name: string;
  heading: string;
  tools: ToolSetting[];
  shown: ToolSetting[];
} & Omit<ToolsProps, "toolsets">) {
  const modes = new Set(tools.map((tool) => tool.mode));
  // No mode when the group's tools differ.
  const value = modes.size === 1 ? [...modes][0]! : null;
  // In a space, a mode no tool in the group may take there.
  const unavailable = (mode: ToolMode) =>
    scope === "space" && tools.every((tool) => looser(mode, tool.orgMode));
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label={name}>
      <div className="flex h-10 items-center justify-between gap-4">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {heading} · {tools.length}
        </h3>
        <ModeToggle
          label={`${name}: when the agent may use them`}
          value={value}
          canChange={canChange}
          labelOf={(mode) => mode.all}
          setByOrg={unavailable}
          onChange={(mode) =>
            onChange(
              tools.map((tool) => tool.id),
              mode,
            )
          }
        />
      </div>
      <ul className="flex flex-col">
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
    </div>
  );
}

// The three modes as icons, one pressed, or none for a group whose tools differ.
function ModeToggle({
  label,
  value,
  canChange,
  labelOf,
  setByOrg,
  onChange,
}: {
  label: string;
  value: ToolMode | null;
  canChange: boolean;
  labelOf: (mode: (typeof MODES)[number]) => string;
  setByOrg: (mode: ToolMode) => boolean;
  onChange: (mode: ToolMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      size="sm"
      spacing={0.5}
      value={value ? [value] : []}
      disabled={!canChange}
      onValueChange={(next: string[]) => {
        const chosen = next.find((mode) => mode !== value);
        if (chosen) onChange(chosen as ToolMode);
      }}
      className="shrink-0 rounded-lg border p-0.5"
    >
      {MODES.map((mode) => {
        const disabled = setByOrg(mode.value);
        const item = (
          <ToggleGroupItem
            value={mode.value}
            aria-label={labelOf(mode)}
            disabled={disabled}
            className={cn("text-muted-foreground", mode.tone)}
          >
            {mode.icon}
          </ToggleGroupItem>
        );
        return (
          <WithTooltip key={mode.value} label={disabled ? SET_BY_ORG : labelOf(mode)}>
            {/* A disabled control takes no pointer, so its wrapper holds the tooltip. */}
            {disabled ? <span className="inline-flex">{item}</span> : item}
          </WithTooltip>
        );
      })}
    </ToggleGroup>
  );
}

// One tool on one line: its name, a lock where the org keeps the space from loosening it, its
// description cut to a line, and its icons. Hovering or pressing the name shows the whole description.
function ToolRow({
  tool,
  scope,
  canChange,
  onChange,
}: {
  tool: ToolSetting;
} & Omit<ToolsProps, "toolsets">) {
  const label = labelOf(tool);
  const description = tool.definition.description;
  const locked = scope === "space" && tool.orgMode !== "allow";
  const text = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm">{label}</span>
        {locked && (
          <LockIcon
            role="img"
            aria-label={SET_BY_ORG}
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
      </span>
      {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
    </>
  );
  const textClass = "flex h-full min-w-0 flex-1 flex-col justify-center text-left";
  return (
    <li aria-label={label} className="flex h-12 items-center justify-between gap-4">
      {description ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={500}
            className={cn(
              textClass,
              "cursor-default rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            {text}
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-auto max-w-[min(24rem,calc(100vw-2rem))] text-xs"
          >
            {description}
          </PopoverContent>
        </Popover>
      ) : (
        <span className={textClass}>{text}</span>
      )}
      <ModeToggle
        label={`${label}: when the agent may use it`}
        value={tool.mode}
        canChange={canChange}
        labelOf={(mode) => mode.label}
        setByOrg={(mode) => scope === "space" && looser(mode, tool.orgMode)}
        onChange={(mode) => onChange([tool.id], mode)}
      />
    </li>
  );
}

// The toolsets as they are read: a placeholder while loading, and what went wrong when they could
// not be read or changed.
function ToolsetsState({
  state,
  error,
  children,
}: {
  state: { isPending: boolean; error: Error | null };
  error?: string;
  children: ReactNode;
}) {
  if (state.error) return <LoadError />;
  if (state.isPending) return <ListSkeleton />;
  return (
    <>
      {children}
      <FieldError>{error}</FieldError>
    </>
  );
}

// The org's toolsets as they are read, and changing their tools' modes.
export function useOrgTools() {
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

  async function setEnabled(toolsetId: string, enabled: boolean) {
    setError(undefined);
    const res = await apiClient.v1.org.toolsets[":toolsetId"].$put({
      param: { toolsetId },
      json: { enabled },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(orgToolsKey, toolsetSettingListSchema.parse(await res.json()));
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  return {
    tools,
    error,
    change: (toolIds: string[], mode: ToolMode) => void change(toolIds, mode),
    setEnabled: (toolsetId: string, enabled: boolean) => void setEnabled(toolsetId, enabled),
  };
}

// The space's toolsets as they are read, and changing their tools' modes.
export function useSpaceTools(spaceId: string) {
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

  async function setEnabled(toolsetId: string, enabled: boolean) {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].toolsets[":toolsetId"].$put({
      param: { id: spaceId, toolsetId },
      json: { enabled },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(
      spaceToolsKey(spaceId),
      toolsetSettingListSchema.parse(await res.json()),
    );
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  return {
    tools,
    error,
    change: (toolIds: string[], mode: ToolMode) => void change(toolIds, mode),
    setEnabled: (toolsetId: string, enabled: boolean) => void setEnabled(toolsetId, enabled),
  };
}

// The org's built-in toolsets in their cards; its MCP servers' toolsets go to `mcp`.
export function OrgToolsList({
  canManage,
  mcp,
}: {
  canManage: boolean;
  mcp: (toolsets: ToolsetSetting[]) => ReactNode;
}) {
  const { tools, error, change, setEnabled } = useOrgTools();
  return (
    <ToolsetsState state={tools} error={error}>
      {tools.data && (
        <>
          <Toolsets
            toolsets={tools.data.filter((toolset) => toolset.source !== "mcp")}
            scope="org"
            canChange={canManage}
            onChange={change}
            onSwitch={setEnabled}
          />
          {mcp(tools.data.filter((toolset) => toolset.source === "mcp"))}
        </>
      )}
    </ToolsetsState>
  );
}

// The space's built-in toolsets in their cards; its MCP servers' toolsets, the org's and its own,
// go to `mcp`.
export function SpaceToolsList({
  spaceId,
  mcp,
}: {
  spaceId: string;
  mcp: (toolsets: ToolsetSetting[]) => ReactNode;
}) {
  const { tools, error, change, setEnabled } = useSpaceTools(spaceId);
  return (
    <ToolsetsState state={tools} error={error}>
      {tools.data && (
        <>
          <Toolsets
            toolsets={tools.data.filter(
              (toolset) => toolset.source !== "mcp" && toolset.tools.length > 0,
            )}
            scope="space"
            canChange
            onChange={change}
            onSwitch={setEnabled}
          />
          {mcp(tools.data.filter((toolset) => toolset.source === "mcp"))}
        </>
      )}
    </ToolsetsState>
  );
}
