// The agent's tools in settings: the Policies card, then a card for each source of toolsets (built
// in, MCP servers) and in it one collapsible row per toolset with counts of its tools' policies and
// a built-in on/off switch; a built-in toolset of no tools is a plain row with its switch. For the
// org, only its owners change them; in a space, the org's tools follow the org's policy by default
// or take a stricter one on top, while the space's own toolsets take its policy directly. The
// toolsets an MCP server card shows are handed to it as they are read.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { type ReactNode } from "react";

import { type ToolsetSetting } from "@/shared/tools.ts";
import { ListSkeleton, LoadError } from "@/web/components/page-states";
import { SettingsCard } from "@/web/shell/settings-page";
import { ScopedSwitch } from "@/web/shell/scoped-switch";
import { SettingsRow } from "@/web/shell/settings-row";
import { plural } from "@/web/lib/plural";
import { FieldError } from "@/web/components/ui/field";
import { PoliciesCard } from "@/web/agent/policies/card";
import { PolicyCounts } from "@/web/agent/policies/tags";
import { PolicyChangeError, ToolPoliciesProvider } from "@/web/agent/policies/provider";
import { toolsQuery } from "@/web/agent/queries";
import { useToolsetSwitch } from "@/web/agent/mutations";
import { useOpenSections } from "@/web/agent/open-sections";
import { ToolsetTools } from "@/web/agent/toolset-tools";

// Each source's card title, in the order the cards show.
const SOURCES: Record<ToolsetSetting["source"], string> = {
  builtin: "System tools",
  mcp: "MCP servers",
};

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
          const control = onSwitch && toolset.source === "builtin" && (
            <ScopedSwitch
              label={toolset.title}
              inSpace={scope === "space"}
              orgOff={toolset.orgEnabled === false}
              checked={on}
              disabled={!canChange || (scope === "space" && toolset.orgEnabled === false)}
              onCheckedChange={(enabled) => onSwitch(toolset.id, enabled)}
            />
          );
          if (toolset.tools.length === 0) {
            return (
              <section
                key={toolset.id}
                aria-label={toolset.title}
                className="flex items-center gap-3 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-col pl-6">
                  <h2
                    className={cn(
                      "truncate text-base leading-6 font-semibold",
                      !on && "text-muted-foreground",
                    )}
                  >
                    {toolset.title}
                  </h2>
                  {toolset.description && (
                    <p className="text-xs text-muted-foreground">{toolset.description}</p>
                  )}
                </div>
                {control}
              </section>
            );
          }
          return (
            <SettingsRow
              key={toolset.id}
              title={toolset.title}
              meta={
                <>
                  {plural(toolset.tools.length, "tool")}
                  <PolicyCounts tools={toolset.tools} />
                </>
              }
              open={sections.isOpen(toolset.id)}
              onOpenChange={(open) => sections.set(toolset.id, open)}
              on={on}
              control={control}
            >
              <ToolsetTools toolset={toolset} scope={scope} />
            </SettingsRow>
          );
        })}
      </div>
    </SettingsCard>
  ));
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
      <PolicyChangeError />
    </>
  );
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
  const scope = { kind: "org" } as const;
  const tools = useQuery(toolsQuery(scope));
  const toolsetSwitch = useToolsetSwitch(scope);
  return (
    <ToolPoliciesProvider scope={scope} canChange={canManage}>
      <PoliciesCard />
      <ToolsetsState state={tools} error={toolsetSwitch.error?.message}>
        {tools.data && (
          <>
            <Toolsets
              toolsets={tools.data.filter((toolset) => toolset.source !== "mcp")}
              scope="org"
              canChange={canManage}
              onSwitch={(toolsetId, enabled) => toolsetSwitch.mutate({ toolsetId, enabled })}
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
  const scope = { kind: "space", spaceId } as const;
  const tools = useQuery(toolsQuery(scope));
  const toolsetSwitch = useToolsetSwitch(scope);
  return (
    <ToolPoliciesProvider scope={scope} canChange>
      <PoliciesCard />
      <ToolsetsState state={tools} error={toolsetSwitch.error?.message}>
        {tools.data && (
          <>
            <Toolsets
              toolsets={tools.data.filter(
                (toolset) =>
                  toolset.source !== "mcp" && (toolset.tools.length > 0 || !!toolset.description),
              )}
              scope="space"
              canChange
              onSwitch={(toolsetId, enabled) => toolsetSwitch.mutate({ toolsetId, enabled })}
            />
            {mcp(tools.data.filter((toolset) => toolset.source === "mcp"))}
          </>
        )}
      </ToolsetsState>
    </ToolPoliciesProvider>
  );
}
