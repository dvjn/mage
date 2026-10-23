// The one look for lists of people, groups, invites and spaces: a table with a Name column, one or
// two columns of context, a Role column and a "…" column. On a phone the context and role columns
// fold into the name's third line and the role moves into the row menu. The row menu is the row's
// only control: changing the role, what the surface offers, and one destructive item last. Each
// surface has one primary action, which always opens a dialog; with no rows, the table gives way
// to an empty state. A subject is an avatar, a name with a muted "(you)", and a muted line below.

import { cn } from "cn";
import { MoreHorizontalIcon, SearchXIcon } from "lucide-react";
import type * as React from "react";

import { EmptyState } from "@/web/components/page-states";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Button } from "@/web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import { WithTooltip } from "@/web/components/with-tooltip";
import { initialsOf } from "@/web/lib/initials";

export interface Column {
  label: string;
  className?: string;
}

// Every table's role column, wide enough for its select.
export const ROLE_COLUMN: Column = { label: "Role", className: "w-36" };

export interface Empty {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

// `columns` are those between the name and the "…"; `count` is how many rows there are.
export function PeopleTable({
  label,
  name = "Name",
  columns,
  count,
  empty,
  filtered,
  children,
}: {
  label: string;
  name?: string;
  columns: Column[];
  count: number;
  empty: Empty;
  // Set while a filter narrows the rows; with none left, clearing it brings them back.
  filtered?: { onClear: () => void };
  children: React.ReactNode;
}) {
  if (count === 0 && filtered) {
    return (
      <EmptyState
        icon={<SearchXIcon />}
        title="No matches"
        description="Nothing here matches the search and filters."
        action={
          <Button variant="outline" onClick={filtered.onClear}>
            Reset
          </Button>
        }
      />
    );
  }
  if (count === 0) return <EmptyState {...empty} />;
  return (
    <Table aria-label={label}>
      <TableHeader className="hidden sm:table-header-group">
        <TableRow className="hover:bg-transparent">
          <TableHead className="px-3 text-xs text-muted-foreground">{name}</TableHead>
          {columns.map((column) => (
            <TableHead
              key={column.label}
              className={cn("w-32 px-3 text-xs text-muted-foreground", column.className)}
            >
              {column.label}
            </TableHead>
          ))}
          <TableHead className="w-10 px-1">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

export function PeopleRow({
  label,
  onOpen,
  className,
  children,
}: {
  label: string;
  // Opens what the row stands for, on a click anywhere outside its controls.
  onOpen?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TableRow
      aria-label={label}
      className={cn("group", onOpen && "cursor-pointer", className)}
      onClick={
        onOpen &&
        ((event) => {
          if ((event.target as HTMLElement).closest("button, a, [role=combobox]")) return;
          onOpen();
        })
      }
    >
      {children}
    </TableRow>
  );
}

// An avatar: a person's or space's initials, or an icon for a group, everyone or an invite.
export type SubjectAvatar = { initials: string } | { icon: React.ReactNode };

export function Subject({
  avatar,
  name,
  you,
  detail,
  folded,
  note,
  size = "default",
}: {
  avatar: SubjectAvatar;
  name: React.ReactNode;
  you?: boolean;
  detail?: React.ReactNode;
  // The hidden columns, shown on a phone only.
  folded?: React.ReactNode;
  // Shown on every size, below the detail.
  note?: React.ReactNode;
  size?: "default" | "sm";
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar size={size}>
        <AvatarFallback className="text-xs font-medium [&_svg]:size-4 group-data-[size=sm]/avatar:[&_svg]:size-3">
          {"icon" in avatar ? avatar.icon : initialsOf(avatar.initials)}
        </AvatarFallback>
      </Avatar>
      <div className="grid min-w-0 leading-tight">
        <span className="truncate text-sm font-medium">
          {name}
          {you && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
        {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
        {folded && (
          <span className="truncate text-xs text-muted-foreground sm:hidden">{folded}</span>
        )}
      </div>
    </div>
  );
}

// The name column's cell; it takes the room the other columns leave, and truncates within it.
export function SubjectCell(props: React.ComponentProps<typeof Subject>) {
  return (
    <TableCell className="w-full max-w-0 px-3 py-2.5">
      <Subject {...props} />
    </TableCell>
  );
}

// A context column's cell, hidden on a phone.
export function ContextCell({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TableCell className={cn("hidden px-3 py-2.5 text-muted-foreground sm:table-cell", className)}>
      {children}
    </TableCell>
  );
}

export interface RoleChoice<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange?: (value: T) => void;
  // Why the viewer, who may change others', may not change this one.
  locked?: string;
}

function labelOf<T extends string>(choice: RoleChoice<T>) {
  return choice.options.find((option) => option.value === choice.value)?.label ?? choice.value;
}

// The role: a select for whoever manages it, disabled with the reason where they may not change
// this one, otherwise its name. Hidden on a phone, where the row menu changes it.
export function RoleCell<T extends string>({
  choice,
  label,
}: {
  choice: RoleChoice<T>;
  label: string;
}) {
  const select = (
    <Select
      value={choice.value}
      disabled={!!choice.locked}
      onValueChange={(next) => next && choice.onChange?.(next as T)}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-28">
        <SelectValue>{() => labelOf(choice)}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {choice.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <TableCell className="hidden w-36 px-3 py-2.5 sm:table-cell">
      {choice.locked ? (
        <WithTooltip label={choice.locked}>
          {/* A disabled control takes no pointer, so its wrapper holds the tooltip. */}
          <span className="inline-flex" tabIndex={0}>
            {select}
          </span>
        </WithTooltip>
      ) : choice.onChange ? (
        select
      ) : (
        <span className="text-sm text-muted-foreground">{labelOf(choice)}</span>
      )}
    </TableCell>
  );
}

// The "…" cell: a menu with the role on a phone, the surface's items, and the destructive item
// last. Empty when there is nothing to offer.
export function ActionsCell<T extends string>({
  label,
  role,
  children,
  destructive,
}: {
  label: string;
  role?: RoleChoice<T>;
  children?: React.ReactNode;
  destructive?: React.ReactNode;
}) {
  const changesRole = !!role?.onChange && !role.locked;
  if (!changesRole && !children && !destructive) return <TableCell className="w-10 px-1" />;
  return (
    <TableCell className="w-10 px-1 py-2 text-right">
      <DropdownMenu>
        <WithTooltip label="Actions">
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Actions for ${label}`}
                className="group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-fine:opacity-0"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="end" className="min-w-48">
          {changesRole && role && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="sm:hidden">Change role</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={role.value}
                  onValueChange={(next) => role.onChange?.(next as T)}
                >
                  {role.options.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {children && <DropdownMenuGroup>{children}</DropdownMenuGroup>}
          {destructive && (children || changesRole) && (
            <DropdownMenuSeparator className={children ? undefined : "sm:hidden"} />
          )}
          {destructive}
        </DropdownMenuContent>
      </DropdownMenu>
    </TableCell>
  );
}

// Reads the next page of a long list.
export function LoadMore({
  more,
  loading,
  onLoad,
}: {
  more: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  if (!more) return null;
  return (
    <div className="flex justify-center pt-2">
      <Button size="sm" variant="outline" disabled={loading} onClick={onLoad}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}

// A surface's one primary action; on a phone, only its icon.
export function HeaderAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} aria-label={label}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
