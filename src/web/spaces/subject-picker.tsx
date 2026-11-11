// Picks a person, or a group, of the org: a text box that opens a popover of suggestions, each an
// avatar, a name with a muted line, and on the right a note when it is in already, which cannot be
// picked. The popover has a height of its own, scrolls and works from the keyboard, so the dialog
// around it keeps its size. What is picked shows below the box, and may be cleared. The caller
// gives the suggestions, searching for them as the text changes, and may add rows of its own below
// the box or a line for when there are none.

import { WithTooltip } from "@/web/components/with-tooltip";
import { CheckIcon, UsersIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type * as React from "react";

import { Button } from "@/web/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/web/components/ui/combobox";
import { Subject, type SubjectAvatar } from "@/web/shell/people-table";

export interface SubjectOption {
  kind: "user" | "group";
  id: string;
  name: string;
  // A person's email, or the group's and how many people are in it.
  detail: string;
  // The address it is found by, for telling whether one typed is already among the options.
  email?: string;
  // Why it cannot be picked: it is in already, in a few words.
  already?: string;
}

// A row of a list below the picker: the person row, with on the right what can be done with it.
export function Suggestion({
  label,
  avatar,
  name,
  you,
  detail,
  children,
}: {
  // What the row is called to assistive tools.
  label?: string;
  avatar: SubjectAvatar;
  name: React.ReactNode;
  you?: boolean;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li aria-label={label} className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <Subject avatar={avatar} name={name} you={you} detail={detail} size="sm" />
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </li>
  );
}

function Already({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <CheckIcon className="size-3" />
      {children}
    </span>
  );
}

function avatarOf(option: SubjectOption): SubjectAvatar {
  return option.kind === "group" ? { icon: <UsersIcon /> } : { initials: option.name };
}

export function SubjectPicker({
  id,
  text,
  onTextChange,
  placeholder,
  options,
  picked,
  onPick,
  before,
  trailing,
  empty,
}: {
  id?: string;
  text: string;
  onTextChange: (text: string) => void;
  placeholder?: string;
  options: SubjectOption[];
  picked: SubjectOption | null;
  // Picking, or with null clearing what was picked.
  onPick: (option: SubjectOption | null) => void;
  // Rows of the caller's own, below the box.
  before?: React.ReactNode;
  // Controls beside the text box.
  trailing?: React.ReactNode;
  // Shown in the popover, for when there are no suggestions.
  empty?: React.ReactNode;
}) {
  const anchor = useComboboxAnchor();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Combobox
        items={options}
        value={null}
        // Picking closes the list, so the one picked is not seen turning into one already in.
        onValueChange={(next: SubjectOption | null) => {
          if (!next) return;
          setOpen(false);
          onPick(next);
        }}
        itemToStringLabel={(option: SubjectOption) => option.name}
        isItemEqualToValue={(a: SubjectOption, b: SubjectOption) =>
          a.kind === b.kind && a.id === b.id
        }
        filter={null}
        inputValue={text}
        // What is typed is the search; picking a suggestion leaves it as it was.
        onInputValueChange={(next: string, details) => {
          // Only typing searches: the list clears the box itself after a pick, which callers
          // would take as a new search and unpick.
          if (details.reason === "input-change") {
            onTextChange(next);
          }
        }}
        // The list opens once something is typed.
        open={open && !!text.trim() && (options.length > 0 || !!empty)}
        onOpenChange={setOpen}
      >
        <div ref={anchor} className="flex gap-2">
          <ComboboxInput
            id={id}
            className="flex-1"
            showTrigger={false}
            placeholder={placeholder}
            // A search, not a login, so password managers leave it alone.
            type="search"
            autoComplete="off"
            data-bwignore
            data-1p-ignore
            data-lpignore="true"
          />
          {trailing}
        </div>
        <ComboboxContent anchor={anchor}>
          <ComboboxList className="max-h-60 p-1">
            {(option: SubjectOption) => (
              <ComboboxItem
                key={`${option.kind}:${option.id}`}
                value={option}
                disabled={!!option.already}
                className="gap-2 data-disabled:opacity-100"
              >
                <div className="min-w-0 flex-1">
                  <Subject
                    avatar={avatarOf(option)}
                    name={option.name}
                    detail={option.detail}
                    size="sm"
                  />
                </div>
                {option.already && <Already>{option.already}</Already>}
              </ComboboxItem>
            )}
          </ComboboxList>
          {empty && options.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">{empty}</p>
          )}
        </ComboboxContent>
      </Combobox>
      {(before || picked) && (
        <ul aria-label="Adding" className="flex flex-col">
          {before}
          {picked && (
            <Suggestion avatar={avatarOf(picked)} name={picked.name} detail={picked.detail}>
              <WithTooltip label={`Clear ${picked.name}`}>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Clear ${picked.name}`}
                  onClick={() => onPick(null)}
                >
                  <XIcon />
                </Button>
              </WithTooltip>
            </Suggestion>
          )}
        </ul>
      )}
    </>
  );
}
