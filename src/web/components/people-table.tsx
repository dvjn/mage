// The one look for tables of people, groups, invites and spaces: a Name column, one or two columns
// of context, a Role column and a "…" column, as columns of a data table. On a phone the context
// and role columns fold into the name's third line and the role moves into the row menu. The row
// menu is the row's only control: changing the role, what the surface offers, and one destructive
// item last. Each surface has one primary action, which always opens a dialog. A subject is an
// avatar, a name with a muted "(you)", and a muted line below.

import { cn } from "cn";
import type { ColumnDef, RowData } from "@tanstack/react-table";
import { MoreHorizontalIcon } from "lucide-react";
import type * as React from "react";

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
import { WithTooltip } from "@/web/components/with-tooltip";
import type { DataTableFeatures, FilterOption } from "@/web/lib/data-table";
import { initialsOf } from "@/web/lib/initials";

type Cell<T extends RowData> = (row: T) => React.ReactNode;

// The name column; it takes the room the other columns leave, and truncates within it.
export function nameColumn<T extends RowData>(
  label: string,
  cell: Cell<T>,
): ColumnDef<DataTableFeatures, T> {
  return {
    id: "name",
    header: label,
    cell: ({ row }) => cell(row.original),
    meta: { label, className: "w-full max-w-0 px-3 py-2.5" },
  };
}

// A context column, hidden on a phone.
export function contextColumn<T extends RowData>(
  id: string,
  label: string,
  cell: Cell<T>,
  className?: string,
): ColumnDef<DataTableFeatures, T> {
  return {
    id,
    header: label,
    cell: ({ row }) => cell(row.original),
    meta: {
      label,
      headerClassName: "w-32",
      className: cn("hidden px-3 py-2.5 text-muted-foreground sm:table-cell", className),
    },
  };
}

// The role column, wide enough for its select, hidden on a phone where the row menu changes it;
// with options, the rows can be narrowed to one role.
export function roleColumn<T extends RowData>(
  cell: Cell<T>,
  options?: FilterOption[],
): ColumnDef<DataTableFeatures, T> {
  return {
    id: "role",
    header: "Role",
    cell: ({ row }) => cell(row.original),
    meta: {
      label: "Role",
      ...(options && { options }),
      headerClassName: "w-36",
      className: "hidden w-36 px-3 py-2.5 sm:table-cell",
    },
  };
}

// The "…" column.
export function actionsColumn<T extends RowData>(cell: Cell<T>): ColumnDef<DataTableFeatures, T> {
  return {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => cell(row.original),
    meta: { headerClassName: "w-10 px-1", className: "w-10 px-1 py-2 text-right" },
  };
}

// A column that only narrows the rows, never shown: from the toolbar when it has options.
export function filterColumn<T extends RowData>(
  id: string,
  label: string,
  options?: FilterOption[],
): ColumnDef<DataTableFeatures, T> {
  return { id, header: label, meta: { label, ...(options && { options }) } };
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
// this one, otherwise its name.
export function RoleControl<T extends string>({
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
  return choice.locked ? (
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
  );
}

// The "…" menu: the role on a phone, the surface's items, and the destructive item last. Nothing
// when there is nothing to offer.
export function ActionsMenu<T extends string>({
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
  if (!changesRole && !children && !destructive) return null;
  return (
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
