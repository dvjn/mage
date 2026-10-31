// Picks a person, or a group, of the org: a text box over a list of suggestions, each an avatar, a
// name with a muted line, and on the right what can be done with it. One that can be picked is a
// button, and once picked holds what the caller shows for it; one already in is marked so. The
// caller gives the suggestions, searching for them as the text changes, and may add rows of its
// own before them or a line when there are none.

import { cn } from "cn";
import { CheckIcon, UsersIcon } from "lucide-react";
import type * as React from "react";

import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { InputGroup, InputGroupInput } from "@/web/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/web/components/ui/item";
import { initialsOf } from "@/web/lib/initials";

export interface SubjectOption {
  kind: "user" | "group";
  id: string;
  name: string;
  // A person's email, or how many are in a group.
  detail: string;
  // Why it cannot be picked: it is in already.
  already?: string;
}

// A row of the list: pickable when given `onPick`.
export function Suggestion({
  avatar,
  name,
  detail,
  picked,
  onPick,
  children,
}: {
  avatar: React.ReactNode;
  name: React.ReactNode;
  detail?: string;
  picked?: boolean;
  onPick?: () => void;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <ItemMedia>
        <Avatar size="sm">
          <AvatarFallback className="text-[0.625rem] font-medium [&_svg]:size-3">
            {avatar}
          </AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full font-normal">
          <span className="truncate">{name}</span>
        </ItemTitle>
        {detail && <ItemDescription className="truncate">{detail}</ItemDescription>}
      </ItemContent>
    </>
  );
  return (
    <Item
      render={<li />}
      size="xs"
      className={cn("flex-nowrap px-0 py-1.5", onPick && "-mx-2 w-auto px-2", picked && "bg-muted")}
    >
      {onPick ? (
        <button
          type="button"
          aria-pressed={picked}
          onClick={onPick}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {children && <ItemActions>{children}</ItemActions>}
    </Item>
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

const same = (a: SubjectOption | null, b: SubjectOption) => a?.kind === b.kind && a.id === b.id;

export function SubjectPicker({
  id,
  text,
  onTextChange,
  placeholder,
  options,
  picked,
  onPick,
  action,
  before,
  empty,
}: {
  id?: string;
  text: string;
  onTextChange: (text: string) => void;
  placeholder?: string;
  options: SubjectOption[];
  picked: SubjectOption | null;
  // Picking the one picked unpicks it.
  onPick: (option: SubjectOption | null) => void;
  // Shown beside the one picked.
  action?: (option: SubjectOption) => React.ReactNode;
  // Rows of the caller's own, first.
  before?: React.ReactNode;
  // Shown under the rows, for when there are none.
  empty?: React.ReactNode;
}) {
  return (
    <>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
        />
      </InputGroup>
      <ul aria-label="Suggestions" className="-mx-2 flex max-h-72 flex-col overflow-y-auto px-2">
        {before}
        {options.map((option) => {
          const chosen = same(picked, option);
          return (
            <Suggestion
              key={`${option.kind}:${option.id}`}
              avatar={option.kind === "group" ? <UsersIcon /> : initialsOf(option.name)}
              name={option.name}
              detail={option.detail}
              {...(!option.already && {
                picked: chosen,
                onPick: () => onPick(chosen ? null : option),
              })}
            >
              {option.already ? <Already>{option.already}</Already> : chosen && action?.(option)}
            </Suggestion>
          );
        })}
        {empty && <li className="py-1.5 text-sm text-muted-foreground">{empty}</li>}
      </ul>
    </>
  );
}
