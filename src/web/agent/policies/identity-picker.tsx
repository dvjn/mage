// Picks the people and groups a policy names.

import { useInfiniteQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { UsersIcon } from "lucide-react";
import { useState } from "react";

import { type PolicyIdentity } from "@/shared/tools.ts";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/web/components/ui/combobox";
import { useDebounced } from "@/web/hooks/use-debounced";
import { groupsPages, membersPages } from "@/web/api/list-queries";
import { initialsOf } from "@/web/lib/initials";
import { EDITORS_IDENTITY } from "@/web/agent/policies/model";

// People and groups of the org, as tokens: typing searches the directory, Enter adds the top
// match and Backspace takes back the last one. Approvers may also be anyone who can edit the
// thread.
export function IdentityPicker({
  label,
  value,
  onChange,
  editors = false,
}: {
  label: string;
  value: PolicyIdentity[];
  onChange: (value: PolicyIdentity[]) => void;
  editors?: boolean;
}) {
  const anchor = useComboboxAnchor();
  const [text, setText] = useState("");
  const [highlighted, setHighlighted] = useState<PolicyIdentity>();
  const q = useDebounced(text.trim());
  const people = useInfiniteQuery(membersPages({ q }, 20));
  const groups = useInfiniteQuery(groupsPages({ q }, 20));
  const chosen = new Set(value.map((identity) => identity.key));
  const options: PolicyIdentity[] = [
    ...(editors && (!q || EDITORS_IDENTITY.name.toLowerCase().includes(q.toLowerCase()))
      ? [EDITORS_IDENTITY]
      : []),
    ...(groups.data?.pages[0]?.items ?? []).map((group) => ({
      key: `group:${group.id}`,
      kind: "group" as const,
      name: group.name,
      detail: `Group · ${group.memberCount} ${group.memberCount === 1 ? "person" : "people"}`,
      stale: false,
    })),
    ...(people.data?.pages[0]?.items ?? []).map((member) => ({
      key: `user:${member.userId}`,
      kind: "user" as const,
      name: member.name,
      detail: member.email,
      stale: false,
    })),
  ].filter((identity) => !chosen.has(identity.key));
  return (
    <Combobox
      multiple
      items={options}
      onItemHighlighted={(identity: PolicyIdentity | undefined) => setHighlighted(identity)}
      value={value}
      onValueChange={(next: PolicyIdentity[]) => {
        onChange(next);
        setText("");
      }}
      itemToStringLabel={(identity: PolicyIdentity) => identity.name}
      isItemEqualToValue={(a: PolicyIdentity, b: PolicyIdentity) => a.key === b.key}
      filter={null}
      inputValue={text}
      onInputValueChange={(next: string) => setText(next)}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {(selected: PolicyIdentity[]) => (
            <>
              {selected.map((identity) => (
                <ComboboxChip
                  key={identity.key}
                  className={cn(identity.stale && "text-muted-foreground line-through")}
                >
                  {identity.kind === "user" ? `@${identity.name}` : identity.name}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                aria-label={label}
                placeholder={selected.length ? "Add more" : "Search people and groups"}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter never sends the form; with nothing highlighted it adds the top match.
                  event.preventDefault();
                  if (highlighted || !options[0]) return;
                  onChange([...value, options[0]]);
                  setText("");
                }}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(identity: PolicyIdentity) => (
            <ComboboxItem key={identity.key} value={identity}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium">
                {identity.kind === "user" ? (
                  initialsOf(identity.name)
                ) : (
                  <UsersIcon className="size-3.5" />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{identity.name}</span>
                {identity.detail && (
                  <span className="truncate text-xs text-muted-foreground">{identity.detail}</span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
