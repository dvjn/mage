// The agent's tools in settings, each by its title, or name, and description from its definition.
// For the org: a switch for each tool, which only its owners change.
// For a space: a switch for each tool, off and disabled where the org turned it off, and whether
// its messagers and guests run each one or need approval. Owners always run; viewers always need
// approval.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  orgToolListSchema,
  spaceToolListSchema,
  type ToolDefinition,
  type ToolLevel,
} from "@/shared/tools.ts";
import { SettingsCard } from "@/web/components/settings/layout";
import { FieldError } from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Switch } from "@/web/components/ui/switch";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";

const orgToolsKey = ["org-tools"];

function spaceToolsKey(spaceId: string) {
  return ["spaces", spaceId, "tools"];
}

const LEVELS: Record<ToolLevel, string> = { run: "Run", approve: "Need approval" };

// A tool's title, or its name where it has none.
function labelOf(definition: ToolDefinition) {
  return definition.title ?? definition.name;
}

function ToolLabel({ definition }: { definition: ToolDefinition }) {
  return (
    <span className="flex flex-col">
      <span className="text-sm">{labelOf(definition)}</span>
      {definition.description && (
        <span className="text-xs text-muted-foreground">{definition.description}</span>
      )}
    </span>
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
      return orgToolListSchema.parse(await res.json());
    },
  });

  async function change(toolId: string, enabled: boolean) {
    setError(undefined);
    const res = await apiClient.v1.org.tools.$patch({ json: { toolId, enabled } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(orgToolsKey, orgToolListSchema.parse(await res.json()));
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  return (
    <SettingsCard
      title="Tools"
      description={
        canManage
          ? "What the agent can do in this organization's threads. A tool turned off here is off in every space."
          : "What the agent can do in this organization's threads. Only the organization's owners can change this."
      }
      state={tools}
    >
      <ul aria-label="Tools" className="flex flex-col divide-y">
        {tools.data?.map((tool) => (
          <li key={tool.id} className="flex items-center justify-between gap-4 py-2.5">
            <ToolLabel definition={tool.definition} />
            <Switch
              aria-label={labelOf(tool.definition)}
              checked={tool.enabled}
              disabled={!canManage}
              onCheckedChange={(checked) => void change(tool.id, checked)}
            />
          </li>
        ))}
      </ul>
      <FieldError>{error}</FieldError>
    </SettingsCard>
  );
}

function LevelSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: ToolLevel;
  disabled: boolean;
  onChange: (level: ToolLevel) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => next && onChange(next as ToolLevel)}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-36">
        <SelectValue>{() => LEVELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {(Object.keys(LEVELS) as ToolLevel[]).map((level) => (
          <SelectItem key={level} value={level}>
            {LEVELS[level]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
      return spaceToolListSchema.parse(await res.json());
    },
  });

  async function change(json: {
    toolId: string;
    enabled?: boolean;
    messager?: ToolLevel;
    guest?: ToolLevel;
  }) {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].tools.$patch({ param: { id: spaceId }, json });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    queryClient.setQueryData(spaceToolsKey(spaceId), spaceToolListSchema.parse(await res.json()));
  }

  return (
    <SettingsCard
      title="Tools"
      description="What the agent can do in this space's threads, and who can let it. Owners always run tools; viewers always need approval."
      state={tools}
    >
      <ul aria-label="Tools" className="flex flex-col divide-y">
        {tools.data?.map((tool) => {
          const label = labelOf(tool.definition);
          const toggle = (
            <Switch
              aria-label={label}
              checked={tool.enabled && tool.orgEnabled}
              disabled={!tool.orgEnabled}
              onCheckedChange={(checked) => void change({ toolId: tool.id, enabled: checked })}
            />
          );
          return (
            <li key={tool.id} aria-label={label} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-4">
                <ToolLabel definition={tool.definition} />
                {tool.orgEnabled ? (
                  toggle
                ) : (
                  <WithTooltip label="Off for the organization">
                    {/* A disabled control takes no pointer, so its wrapper holds the tooltip. */}
                    <span className="inline-flex" tabIndex={0}>
                      {toggle}
                    </span>
                  </WithTooltip>
                )}
              </div>
              <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:gap-6">
                <span className="flex items-center justify-between gap-2 sm:justify-start">
                  Messagers
                  <LevelSelect
                    label={`Messagers: ${label}`}
                    value={tool.messager}
                    disabled={!tool.enabled || !tool.orgEnabled}
                    onChange={(messager) => void change({ toolId: tool.id, messager })}
                  />
                </span>
                <span className="flex items-center justify-between gap-2 sm:justify-start">
                  Guests
                  <LevelSelect
                    label={`Guests: ${label}`}
                    value={tool.guest}
                    disabled={!tool.enabled || !tool.orgEnabled}
                    onChange={(guest) => void change({ toolId: tool.id, guest })}
                  />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <FieldError>{error}</FieldError>
    </SettingsCard>
  );
}
