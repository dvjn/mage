// The menu of commands over the composer while a message is a slash and the start of a command's
// name: those whose names, or a part of one after a `-`, `_` or `:`, start with what was typed,
// those whose whole names start with it first, each with what it takes, what it does and the tag
// saying what it is.

import { cn } from "cn";
import { useEffect } from "react";

import type { ThreadCommand } from "@/shared/threads/commands.ts";
import { Badge } from "@/web/components/ui/badge";

// The commands the menu offers for the composer's text, or none when the text is not a slash and
// the start of a name.
export function matchingCommands(commands: readonly ThreadCommand[], text: string) {
  const typed = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  if (typed === undefined) return [];
  const found = commands.filter((command) =>
    command.name
      .toLowerCase()
      .split(/(?<=[-_:])/)
      .some((_, index, parts) => parts.slice(index).join("").startsWith(typed)),
  );
  return found.toSorted(
    (a, b) =>
      Number(!a.name.toLowerCase().startsWith(typed)) -
        Number(!b.name.toLowerCase().startsWith(typed)) || a.name.localeCompare(b.name),
  );
}

export const COMMAND_MENU = "command-menu";

export function commandOptionId(index: number) {
  return `${COMMAND_MENU}-${index}`;
}

export function CommandMenu({
  commands,
  active,
  onPick,
}: {
  commands: readonly ThreadCommand[];
  active: number;
  onPick: (command: ThreadCommand) => void;
}) {
  // The highlighted command stays in view as the arrow keys move past the menu's edge.
  useEffect(() => {
    document.getElementById(commandOptionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, commands]);
  return (
    <div
      id={COMMAND_MENU}
      role="listbox"
      aria-label="Commands"
      className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
    >
      {commands.map((command, index) => (
        <div
          key={command.name}
          id={commandOptionId(index)}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          className={cn(
            "flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5",
            index === active && "bg-accent text-accent-foreground",
          )}
          // Keeps the composer focused.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
        >
          <span className="shrink-0 font-mono">/{command.name}</span>
          {command.argumentHint && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {command.argumentHint}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {command.description}
          </span>
          {command.tag && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              {command.tag}
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}
