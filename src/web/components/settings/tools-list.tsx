// The agent's tools in settings: the Policies card, then a card for each source of toolsets (built
// in, MCP servers) and in it one collapsible row per toolset with counts of its tools' policies and
// a built-in on/off switch. Inside, its tools are split under plain read-only and interactive
// headings. Each heading's picker sets all its tools at once; each tool takes a policy or is off.
// For the org, only its owners change them; in a space, the org's tools follow the org's policy by
// default or take a stricter one on top, while the space's own toolsets take its policy directly. Which toolsets are open is remembered in this browser for the signed-in person. The
// toolsets an MCP server card shows are handed to it as they are read.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { type ToolSetting, type ToolsetSetting, toolsetSettingListSchema } from "@/shared/tools.ts";
import { ListSkeleton, LoadError } from "@/web/components/page-states";
import { SettingsCard } from "@/web/components/settings/layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { FieldError } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import {
  PoliciesCard,
  PolicyCounts,
  PolicyPicker,
  ToolPoliciesProvider,
} from "@/web/components/settings/tool-policies";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Switch } from "@/web/components/ui/switch";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { meQuery } from "@/web/lib/queries";

export const orgToolsKey = ["org-tools"];

export function spaceToolsKey(spaceId: string) {
  return ["spaces", spaceId, "tools"];
}

// Each source's card title, in the order the cards show.
const SOURCES: Record<ToolsetSetting["source"], string> = {
  builtin: "System tools",
  mcp: "MCP servers",
};

// A toolset with more tools than this gets a filter.
const FILTER_FROM = 8;

// A tool's title, or its name where it has none.
function labelOf(tool: ToolSetting) {
  return tool.definition.title ?? tool.definition.name;
}

// Which toolsets the person has open, kept in this browser; a toolset never toggled is closed.
export function useOpenSections(scope: "org" | "space") {
  const userId = useQuery(meQuery).data?.user.id ?? "";
  const key = `mage:tool-sections:${userId}:${scope}`;
  const [kept, setKept] = useState(() => ({ key, open: storedSections(key) }));
  // The person is known only once the app has read who they are; read their sections then.
  if (kept.key !== key) setKept({ key, open: storedSections(key) });
  const open = kept.key === key ? kept.open : storedSections(key);
  return {
    isOpen: (id: string) => open[id] ?? false,
    set(id: string, next: boolean) {
      const all = { ...open, [id]: next };
      setKept({ key, open: all });
      try {
        localStorage.setItem(key, JSON.stringify(all));
      } catch {
        // Storage can be unavailable; the toolsets then start closed.
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

interface ToolsProps {
  toolsets: ToolsetSetting[];
  scope: "org" | "space";
  canChange: boolean;
  onSwitch?: (toolsetId: string, enabled: boolean) => void;
}

function Toolsets({ toolsets, scope, canChange, onSwitch }: ToolsProps) {
  const sections = useOpenSections(scope);
  // A card only for a source that has toolsets.
  const sources = (Object.keys(SOURCES) as ToolsetSetting["source"][])
    .map((source) => ({
      source,
      toolsets: toolsets.filter((t) => t.source === source),
    }))
    .filter((group) => group.toolsets.length > 0);
  return sources.map(({ source, toolsets: inSource }) => (
    <SettingsCard key={source} title={SOURCES[source]}>
      <div className="-my-3 flex flex-col divide-y">
        {inSource.map((toolset) => {
          const on = toolset.enabled ?? true;
          return (
            <ToolsetSection
              key={toolset.id}
              title={toolset.title}
              count={toolset.tools.length}
              counts={<PolicyCounts tools={toolset.tools} />}
              open={sections.isOpen(toolset.id)}
              onOpenChange={(open) => sections.set(toolset.id, open)}
              on={on}
              control={
                onSwitch &&
                toolset.source === "builtin" && (
                  <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {toolset.orgEnabled === false
                      ? "Off by organization"
                      : scope === "org" && (on ? "On" : "Off")}
                    <Switch
                      size="sm"
                      aria-label={`${toolset.title}: ${scope === "space" ? "on in this space" : "on"}`}
                      checked={on}
                      disabled={!canChange || (scope === "space" && toolset.orgEnabled === false)}
                      onCheckedChange={(enabled) => onSwitch(toolset.id, enabled)}
                    />
                  </label>
                )
              }
            >
              <ToolsetTools toolset={toolset} scope={scope} />
            </ToolsetSection>
          );
        })}
      </div>
    </SettingsCard>
  ));
}

// One toolset as a collapsible row: its title and badge, how many tools it has and their
// policies, and a control beside it; its tools inside, dimmed while it is off.
export function ToolsetSection({
  title,
  badge,
  count,
  counts,
  open,
  onOpenChange,
  on = true,
  control,
  children,
}: {
  title: string;
  badge?: ReactNode;
  count: number | null;
  counts?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  on?: boolean;
  control?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} render={<section aria-label={title} />}>
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger className="group/trigger flex w-full items-start gap-2 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <span className="flex h-6 shrink-0 items-center">
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
            </span>
            {/* On a phone the counts go under the title. */}
            <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "truncate text-base leading-6 font-semibold",
                    !on && "text-muted-foreground",
                  )}
                >
                  {title}
                </span>
                {badge}
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground sm:ml-auto">
                {count !== null && (count === 1 ? "1 tool" : `${count} tools`)}
                {counts}
              </span>
            </span>
          </CollapsibleTrigger>
        </h2>
        {control}
      </div>
      <CollapsibleContent
        className={cn("mb-3 ml-[7px] border-l-2 pl-3 sm:pl-[15px]", !on && "opacity-60")}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// A toolset's tools under their read-only and interactive headings, with a filter for many.
export function ToolsetTools({
  toolset,
  scope,
}: {
  toolset: ToolsetSetting;
  scope: "org" | "space";
}) {
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
      label: "read-only",
      tools: toolset.tools.filter(readOnly),
    },
    {
      id: "interactive",
      name: "Interactive tools",
      heading: "Interactive",
      label: "interactive",
      tools: toolset.tools.filter((tool) => !readOnly(tool)),
    },
  ].filter((group) => group.tools.length > 0);
  // In a space, the org's tools take an extra rule on the org's policy.
  const extra = scope === "space" && toolset.scope === "org";
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
          target={`${toolset.title} ${group.label} tools`}
          tools={group.tools}
          shown={group.tools.filter((tool) => shown.includes(tool))}
          extra={extra}
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
  target,
  tools,
  shown,
  extra,
}: {
  name: string;
  heading: string;
  target: string;
  tools: ToolSetting[];
  shown: ToolSetting[];
  extra: boolean;
}) {
  const values = new Set(tools.map((tool) => tool.policy));
  // Mixed when the group's tools differ.
  const value = values.size === 1 ? [...values][0]! : null;
  const inherited = new Set(tools.map((tool) => tool.orgPolicy));
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label={name}>
      <div className="flex h-10 items-center justify-between gap-4">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {heading} · {tools.length}
        </h3>
        <PolicyPicker
          label={extra ? `${name} policy in this space` : `${name} policy`}
          value={value}
          mixed={values.size > 1}
          extra={extra}
          inherited={inherited.size === 1 ? [...inherited][0]! : undefined}
          target={{ toolIds: tools.map((tool) => tool.id), label: target }}
        />
      </div>
      <ul className="flex flex-col">
        {shown.map((tool) => (
          <ToolRow key={tool.id} tool={tool} extra={extra} />
        ))}
      </ul>
    </div>
  );
}

// One tool on one line: its name, its description cut to a line, and its picker; in a space on
// the org's tools, the picker follows the org's policy by default. Hovering or pressing the name
// shows the whole description.
function ToolRow({ tool, extra }: { tool: ToolSetting; extra: boolean }) {
  const label = labelOf(tool);
  const description = tool.definition.description;
  const text = (
    <>
      <span className="truncate text-sm">{label}</span>
      {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
    </>
  );
  const textClass = "flex h-full min-w-0 flex-1 flex-col justify-center text-left";
  return (
    <li aria-label={label} className="flex min-h-12 items-center justify-between gap-3">
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
      <PolicyPicker
        label={extra ? `${label} policy in this space` : `${label} policy`}
        value={tool.policy}
        extra={extra}
        inherited={tool.orgPolicy}
        target={{ toolIds: [tool.id], label }}
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

// The org's toolsets as they are read, and setting their tools to policies.
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

  async function change(toolIds: string[], policy: string | null) {
    setError(undefined);
    const res = await apiClient.v1.org.tools.$patch({
      json: { toolIds, policy },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(orgToolsKey, toolsetSettingListSchema.parse(await res.json()));
    await queryClient.invalidateQueries({ queryKey: ["threads"] });
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
    change,
    setEnabled: (toolsetId: string, enabled: boolean) => void setEnabled(toolsetId, enabled),
  };
}

// The space's toolsets as they are read, and setting their tools to policies.
export function useSpaceTools(spaceId: string) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const tools = useQuery({
    queryKey: spaceToolsKey(spaceId),
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].tools.$get({
        param: { id: spaceId },
      });
      if (!res.ok) throw new Error("could not read the tools");
      return toolsetSettingListSchema.parse(await res.json());
    },
  });

  async function change(toolIds: string[], policy: string | null) {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].tools.$patch({
      param: { id: spaceId },
      json: { toolIds, policy },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(
      spaceToolsKey(spaceId),
      toolsetSettingListSchema.parse(await res.json()),
    );
    await queryClient.invalidateQueries({ queryKey: ["threads"] });
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
    change,
    setEnabled: (toolsetId: string, enabled: boolean) => void setEnabled(toolsetId, enabled),
  };
}

// The org's policies, then its built-in toolsets in their cards; its MCP servers' toolsets go to
// `mcp`.
export function OrgToolsList({
  canManage,
  mcp,
}: {
  canManage: boolean;
  mcp: (toolsets: ToolsetSetting[]) => ReactNode;
}) {
  const { tools, error, change, setEnabled } = useOrgTools();
  return (
    <ToolPoliciesProvider scope={{ kind: "org" }} canChange={canManage} change={change}>
      <PoliciesCard />
      <ToolsetsState state={tools} error={error}>
        {tools.data && (
          <>
            <Toolsets
              toolsets={tools.data.filter((toolset) => toolset.source !== "mcp")}
              scope="org"
              canChange={canManage}
              onSwitch={setEnabled}
            />
            {mcp(tools.data.filter((toolset) => toolset.source === "mcp"))}
          </>
        )}
      </ToolsetsState>
    </ToolPoliciesProvider>
  );
}

// The space's policies, then its built-in toolsets in their cards; its MCP servers' toolsets, the
// org's and its own, go to `mcp`.
export function SpaceToolsList({
  spaceId,
  mcp,
}: {
  spaceId: string;
  mcp: (toolsets: ToolsetSetting[]) => ReactNode;
}) {
  const { tools, error, change, setEnabled } = useSpaceTools(spaceId);
  return (
    <ToolPoliciesProvider scope={{ kind: "space", spaceId }} canChange change={change}>
      <PoliciesCard />
      <ToolsetsState state={tools} error={error}>
        {tools.data && (
          <>
            <Toolsets
              toolsets={tools.data.filter(
                (toolset) => toolset.source !== "mcp" && toolset.tools.length > 0,
              )}
              scope="space"
              canChange
              onSwitch={setEnabled}
            />
            {mcp(tools.data.filter((toolset) => toolset.source === "mcp"))}
          </>
        )}
      </ToolsetsState>
    </ToolPoliciesProvider>
  );
}
