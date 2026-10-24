// The agent's tools in settings, one collapsible row per toolset with how many of its tools are
// allowed, ask or are blocked. Inside, its tools are split under plain read-only and interactive
// headings. Each heading's icons set all its tools at once; each tool is allowed, asks every time,
// or is blocked. For the org, only its owners change them; for a space, a tool can only be made
// stricter than the org has it. Which toolsets are open is remembered in this browser for the
// signed-in person.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  BanIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  HandIcon,
  LockIcon,
  SearchIcon,
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
import { Badge } from "@/web/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { FieldError } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/web/components/ui/toggle-group";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { meQuery } from "@/web/lib/queries";

const orgToolsKey = ["org-tools"];

function spaceToolsKey(spaceId: string) {
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
    tone: "aria-pressed:text-status-waiting",
    color: "text-status-waiting",
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
          scope={scope}
          canChange={canChange}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

// How many of the tools are in each mode: an icon and a number for each mode some tool is in.
function ModeCounts({ tools }: { tools: ToolSetting[] }) {
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
}: {
  toolset: ToolsetSetting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const count = toolset.tools.length;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<section aria-label={toolset.title} />}
    >
      <h2>
        <CollapsibleTrigger className="group/trigger flex w-full items-start gap-2 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="flex h-6 shrink-0 items-center">
            <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
          </span>
          {/* On a phone the counts go under the title. */}
          <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base leading-6 font-semibold">{toolset.title}</span>
              <Badge variant="secondary">{SOURCES[toolset.source]}</Badge>
            </span>
            <span className="flex items-center gap-3 text-xs text-muted-foreground sm:ml-auto">
              {count === 1 ? "1 tool" : `${count} tools`}
              <ModeCounts tools={toolset.tools} />
            </span>
          </span>
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent className="mb-3 ml-[7px] flex flex-col gap-1 border-l-2 pl-3 sm:pl-[15px]">
        {count > FILTER_FROM && (
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
            scope={scope}
            canChange={canChange}
            onChange={onChange}
          />
        ))}
        {needle && shown.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">No matches</p>
        )}
      </CollapsibleContent>
    </Collapsible>
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
    <div className="flex flex-col gap-2">
      {children}
      <FieldError>{error}</FieldError>
    </div>
  );
}

export function OrgToolsList({ canManage }: { canManage: boolean }) {
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
    <ToolsetsState state={tools} error={error}>
      {tools.data && (
        <Toolsets
          toolsets={tools.data}
          scope="org"
          canChange={canManage}
          onChange={(toolIds, mode) => void change(toolIds, mode)}
        />
      )}
    </ToolsetsState>
  );
}

export function SpaceToolsList({ spaceId }: { spaceId: string }) {
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
    <ToolsetsState state={tools} error={error}>
      {tools.data && (
        <Toolsets
          toolsets={tools.data}
          scope="space"
          canChange
          onChange={(toolIds, mode) => void change(toolIds, mode)}
        />
      )}
    </ToolsetsState>
  );
}
