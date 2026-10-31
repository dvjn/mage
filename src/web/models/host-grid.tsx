// The hosts a provider can be added from, in a searchable grid by kind.

import { type ReactNode } from "react";

import { HOST_GROUPS, type HostGroup, type HostId, hostOf } from "@/shared/hosts.ts";
import { HostMark } from "@/web/models/marks";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";

export function Choice({
  title,
  description,
  icon,
  disabled,
  onSelect,
}: {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {icon && <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>}
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

// Every host by its kind, as tiles of its mark, name and what it connects with, found by any of
// them; one already signed in to is shown but cannot be chosen.
export function HostGrid({
  hosts,
  taken,
  onSelect,
}: {
  hosts: HostId[];
  taken: (host: HostId) => boolean;
  onSelect: (host: HostId) => void;
}) {
  const groups = (Object.keys(HOST_GROUPS) as HostGroup[])
    .map((group) => ({ group, hosts: hosts.filter((host) => hostOf(host).group === group) }))
    .filter(({ hosts: list }) => list.length > 0);
  return (
    <Command className="rounded-none! bg-transparent p-0">
      <CommandInput placeholder="Search providers" aria-label="Search providers" autoFocus />
      <CommandList className="max-h-[min(60vh,30rem)]">
        <CommandEmpty>No providers found.</CommandEmpty>
        {groups.map(({ group, hosts: list }) => (
          <CommandGroup
            key={group}
            heading={HOST_GROUPS[group]}
            className="px-0 **:[[cmdk-group-items]]:grid **:[[cmdk-group-items]]:grid-cols-2 **:[[cmdk-group-items]]:gap-1 sm:**:[[cmdk-group-items]]:grid-cols-3"
          >
            {list.map((host) => {
              const { label, hint } = hostOf(host);
              const connected = taken(host);
              return (
                <CommandItem
                  key={host}
                  value={host}
                  keywords={[label, hint, HOST_GROUPS[group]]}
                  aria-label={`${label} · ${connected ? "Already connected" : hint}`}
                  disabled={connected}
                  onSelect={() => onSelect(host)}
                  className="items-start gap-2.5 rounded-lg! border border-transparent p-2 data-selected:border-border [&>svg:last-child]:hidden"
                >
                  <HostMark host={host} className="mt-0.5 size-5" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {connected ? "Already connected" : hint}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
