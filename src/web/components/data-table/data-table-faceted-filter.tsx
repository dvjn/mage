// A column's filter: a dashed button named after the column, with the value set beside the name,
// that opens its values, searchable when there are many. The value set carries the one check, and
// choosing it again, or Clear filter, clears it.

import type { Column, RowData } from "@tanstack/react-table";
import { useState } from "react";

import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/web/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { Separator } from "@/web/components/ui/separator";
import type { DataTableFeatures, FilterOption } from "@/web/lib/data-table";

// Above this many values the list gets a search.
const SEARCH_FROM = 8;

interface DataTableFacetedFilterProps<TData extends RowData, TValue> {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
  options: FilterOption[];
}

export function DataTableFacetedFilter<TData extends RowData, TValue>({
  column,
  title,
  options,
}: DataTableFacetedFilterProps<TData, TValue>) {
  const [open, setOpen] = useState(false);
  const value = column.getFilterValue();
  const chosen = options.find((option) => option.value === value);

  function choose(next: string | undefined) {
    column.setFilterValue(next);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="border-dashed"
            aria-label={chosen ? `${title}: ${chosen.label}` : title}
          />
        }
      >
        {title}
        {chosen && (
          <>
            <Separator
              orientation="vertical"
              className="mx-0.5 data-vertical:h-4 data-vertical:self-center"
            />
            <Badge variant="secondary" className="rounded-sm px-1 font-normal">
              {chosen.label}
            </Badge>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent aria-label={`${title} filter`} align="start" className="w-48 p-0">
        <Command>
          {options.length > SEARCH_FROM && <CommandInput placeholder={title} />}
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const selected = option.value === chosen?.value;
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    data-checked={selected || undefined}
                    onSelect={() => choose(selected ? undefined : option.value)}
                  >
                    {option.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {chosen && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="Clear filter" onSelect={() => choose(undefined)}>
                    Clear filter
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
