// What a tool is called, by its definition alone, as a breadcrumb: its toolset or MCP server in
// muted text that lights up with the line on hover, a chevron, and its title or else its name
// (loading a skill as Loaded and the skill's name).

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";

import { LOAD_SKILL } from "@/shared/skills.ts";
import type { ToolDefinition } from "@/shared/tools.ts";
import type { ToolRow } from "@/shared/transcript.ts";

// What a tool is called: its title, or its name where it has none; loading a skill names the skill.
function toolName(row: ToolRow, definition: ToolDefinition | undefined) {
  const skill = (row.input as { name?: unknown } | null)?.name;
  if (row.toolId === LOAD_SKILL && typeof skill === "string") {
    return row.state === "ran" ? `Loaded ${skill}` : `Load ${skill}`;
  }
  return definition?.title ?? row.toolId;
}

// What a tool is called, in words: its server's name before its own where it has a server.
export function toolPath(row: ToolRow, definition: ToolDefinition | undefined) {
  return [definition?.toolset, toolName(row, definition)].filter(Boolean).join(" › ");
}

// An item of a flex row that grows from nothing into the room its siblings leave, up to its own
// width, so that it truncates before they do.
export const GIVES_WAY = "min-w-0 max-w-max flex-1 truncate";

// What a tool is called, as a breadcrumb inside a flex row: its server's name in muted text and a
// chevron before its own where it has a server. Where the row is short, the server's name truncates
// first, sharing the room the tool's name leaves with any other item of the row that gives way the
// same, and the tool's own name only once the server's is gone. It takes the class given.
export function ToolCrumb({
  row,
  definition,
  className,
}: {
  row: ToolRow;
  definition: ToolDefinition | undefined;
  className?: string;
}) {
  return (
    <>
      {definition?.toolset && (
        <>
          <span className={cn(GIVES_WAY, "text-muted-foreground group-hover/tool:text-foreground")}>
            {definition.toolset}
          </span>
          <ChevronRightIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground group-hover/tool:text-foreground"
          />
        </>
      )}
      <span className={cn("min-w-0 truncate", className)}>{toolName(row, definition)}</span>
    </>
  );
}
