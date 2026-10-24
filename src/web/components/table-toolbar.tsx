// Narrows a table: a search, then one dashed button per filter, named after its field, that opens
// its values, searchable when there are many, with a check on the one set and shows it beside the
// name once set; while anything is
// set, how many rows match and Reset. The table's one action sits at the end. On a phone the search
// takes the row and the filters sit below it. The server searches; the values live in the page's
// address, so links and back keep them.

import { cn } from "cn";
import { PlusCircleIcon, SearchIcon } from "lucide-react";
import type * as React from "react";
import { useEffect, useState } from "react";

import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Separator } from "@/web/components/ui/separator";
import { useDebounced } from "@/web/hooks/use-debounced";

export interface Filter {
  label: string;
  // Unset means any.
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}

// Above this many values the list gets a search.
const SEARCH_FROM = 8;

export function FilterButton({ filter }: { filter: Filter }) {
  const [open, setOpen] = useState(false);
  const chosen = filter.options.find((option) => option.value === filter.value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="border-dashed"
            aria-label={chosen ? `${filter.label}: ${chosen.label}` : filter.label}
          />
        }
      >
        <PlusCircleIcon />
        {filter.label}
        {chosen && (
          <>
            <Separator orientation="vertical" className="mx-0.5 data-vertical:h-4" />
            <Badge variant="secondary" className="rounded-sm px-1 font-normal">
              {chosen.label}
            </Badge>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-0">
        <Command>
          {filter.options.length > SEARCH_FROM && (
            <CommandInput placeholder={`Find a ${filter.label.toLowerCase()}`} />
          )}
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {filter.options.map((option) => {
                const selected = option.value === filter.value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    data-checked={selected || undefined}
                    onSelect={() => {
                      // Choosing the value set again clears it.
                      filter.onChange(selected ? undefined : option.value);
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function TableToolbar({
  search,
  filters = [],
  total,
  onReset,
  action,
  className,
}: {
  search?: { label: string; value: string; onChange: (value: string) => void };
  filters?: Filter[];
  // How many rows match, once known.
  total: number | undefined;
  onReset: () => void;
  action?: React.ReactNode;
  className?: string;
}) {
  const active = !!search?.value || filters.some((filter) => filter.value !== undefined);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {search && (
        <InputGroup className="h-8 w-full sm:w-56">
          <InputGroupInput
            type="search"
            aria-label={search.label}
            placeholder={search.label}
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
          />
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
        </InputGroup>
      )}
      {filters.map((filter) => (
        <FilterButton key={filter.label} filter={filter} />
      ))}
      {active && (
        <>
          <Button variant="ghost" onClick={onReset}>
            Reset
          </Button>
          {total !== undefined && (
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {total} {total === 1 ? "result" : "results"}
            </span>
          )}
        </>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

// The search box's text, kept as typed and written to the address once typing pauses.
export function useSearchText(value: string, onSettle: (value: string) => void) {
  const [text, setText] = useState(value);
  const settled = useDebounced(text);
  const [last, setLast] = useState(value);
  // The address changed by other means, as by Reset or going back.
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  useEffect(() => {
    if (settled !== value) onSettle(settled);
    // Only a settled change of the text writes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  return [text, setText] as const;
}
