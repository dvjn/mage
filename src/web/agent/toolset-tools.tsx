// A toolset's tools, split under plain read-only and interactive headings, with a filter for many.
// Each heading's picker sets all its tools at once; each tool takes a policy or is off.

import { cn } from "cn";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { type ToolSetting, type ToolsetSetting } from "@/shared/tools.ts";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { PolicyPicker } from "@/web/agent/policies/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";

// A toolset with more tools than this gets a filter.
const FILTER_FROM = 8;

// A tool's title, or its name where it has none.
function labelOf(tool: ToolSetting) {
  return tool.definition.title ?? tool.definition.name;
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
