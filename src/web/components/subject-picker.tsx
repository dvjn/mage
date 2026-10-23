// Picks a person, or a group, of the org: a button opening a searchable list, people first with
// their emails, then groups with how many are in each. The caller gives the options, leaving out
// those already chosen, and may search for them itself as the text changes.

import { cn } from "cn";
import { UsersIcon } from "lucide-react";
import type * as React from "react";

import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/web/components/ui/combobox";
import { selectTriggerClassName } from "@/web/components/ui/select";
import { initialsOf } from "@/web/lib/initials";

export interface SubjectOption {
  kind: "user" | "group";
  id: string;
  name: string;
  // A person's email, or how many are in a group.
  detail: string;
}

interface Section {
  value: string;
  label: string;
  items: SubjectOption[];
}

export function SubjectPicker({
  id,
  options,
  value,
  onChange,
  placeholder = "Pick a person or group",
  empty = "Nobody else to add.",
  query,
  onQueryChange,
  className,
}: {
  id?: string;
  options: SubjectOption[];
  value: SubjectOption | null;
  onChange: (option: SubjectOption | null) => void;
  placeholder?: string;
  // Shown when nobody is left to pick, or nobody matches.
  empty?: React.ReactNode;
  // The search text, when the caller searches for the options itself.
  query?: string;
  onQueryChange?: (query: string) => void;
  className?: string;
}) {
  const sections: Section[] = [
    { value: "user", label: "People", items: options.filter((o) => o.kind === "user") },
    { value: "group", label: "Groups", items: options.filter((o) => o.kind === "group") },
  ].filter((section) => section.items.length > 0);
  return (
    <Combobox
      items={sections}
      value={value}
      onValueChange={(option) => onChange(option)}
      itemToStringLabel={(option: SubjectOption) => option.name}
      isItemEqualToValue={(a: SubjectOption, b: SubjectOption) =>
        a.kind === b.kind && a.id === b.id
      }
      {...(onQueryChange && {
        filter: null,
        inputValue: query ?? "",
        onInputValueChange: (next: string) => onQueryChange(next),
      })}
    >
      <ComboboxTrigger
        id={id}
        data-size="default"
        className={cn(selectTriggerClassName, "w-full", className)}
      >
        <span className={cn("flex-1 truncate text-left", !value && "text-muted-foreground")}>
          {value?.name ?? placeholder}
        </span>
      </ComboboxTrigger>
      <ComboboxContent className="w-auto min-w-(--anchor-width)">
        <ComboboxInput
          showTrigger={false}
          placeholder="Search"
          aria-label="Search people and groups"
        />
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {(section: Section, index: number) => (
            <ComboboxGroup key={section.value} items={section.items}>
              <ComboboxLabel>{section.label}</ComboboxLabel>
              <ComboboxCollection>
                {(option: SubjectOption) => (
                  <ComboboxItem key={`${option.kind}:${option.id}`} value={option}>
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.5625rem] font-medium">
                      {option.kind === "group" ? (
                        <UsersIcon className="size-3" />
                      ) : (
                        initialsOf(option.name)
                      )}
                    </span>
                    <span className="truncate">{option.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
              {index < sections.length - 1 && <ComboboxSeparator />}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
