// The one look for tables of people, groups, invites and spaces: a Name column, one or two columns
// of context, a Role column and an actions column, as columns of a data table. On a phone the
// context and role columns fold into the name's third line and the role moves into the row menu.
// The row's controls are the role, an × that removes it after a question, and a "More" menu for
// what else the surface offers. Each surface has one primary action, which always opens a dialog.
// A subject is an avatar, a name with a muted "(you)", and a muted line below; it is the one look
// of a person, in tables and in the lists below a picker.

import { cn } from "cn";
import type { ColumnDef, RowData } from "@tanstack/react-table";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Button } from "@/web/components/ui/button";
import { AccessLevel, type Level } from "@/web/components/access-level";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { MoreMenu } from "@/web/components/more-menu";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/web/components/ui/dropdown-menu";
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

// The role column, wide enough for its toggle group, hidden on a phone where the row menu changes
// it; with options, the rows can be narrowed to one role.
export function roleColumn<T extends RowData, V extends string = string>(
  cell: (row: T) => { label: string } & RoleChoice<V>,
  options?: FilterOption[],
): ColumnDef<DataTableFeatures, T> {
  return {
    id: "role",
    header: "Role",
    cell: ({ row }) => {
      const { label, ...choice } = cell(row.original);
      return <RoleControl choice={choice} label={label} />;
    },
    meta: {
      label: "Role",
      ...(options && { options }),
      headerClassName: "w-32",
      className: "hidden w-32 px-3 py-2.5 sm:table-cell",
    },
  };
}

// The actions column: the controls of a row, at the right.
export function actionsColumn<T extends RowData>(cell: Cell<T>): ColumnDef<DataTableFeatures, T> {
  return {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => cell(row.original),
    meta: { headerClassName: "w-20 px-1", className: "w-20 px-1 py-2" },
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

export function PersonAvatar({
  avatar,
  size = "default",
}: {
  avatar: SubjectAvatar;
  size?: "default" | "sm";
}) {
  return (
    <Avatar size={size}>
      <AvatarFallback className="text-xs font-medium [&_svg]:size-4 group-data-[size=sm]/avatar:text-[0.625rem] group-data-[size=sm]/avatar:[&_svg]:size-3">
        {"icon" in avatar ? avatar.icon : initialsOf(avatar.initials)}
      </AvatarFallback>
    </Avatar>
  );
}

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
      <PersonAvatar avatar={avatar} size={size} />
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

export interface RoleChoice<T extends string = string> {
  value: T;
  levels: readonly Level<T>[];
  onChange?: (value: T) => void;
  // Why the viewer, who may change others', may not change this one.
  locked?: string;
}

// The role, as the toggle group every access choice is: changed by whoever manages it, disabled
// with the reason where they may not change this one, otherwise its name.
function RoleControl<T extends string>({
  choice,
  label,
}: {
  choice: RoleChoice<T>;
  label: string;
}) {
  return (
    <AccessLevel
      levels={choice.levels}
      value={choice.value}
      label={label}
      {...(choice.onChange && { onChange: choice.onChange })}
      {...(choice.locked && { locked: choice.locked })}
    />
  );
}

// The row menu of a row whose role column is hidden, which is a phone: it changes the role.
// Nothing when the reader may not.
export function RoleMenu<T extends string>({ name, role }: { name: string; role: RoleChoice<T> }) {
  return (
    <MoreMenu row name={name} empty={!role.onChange || !!role.locked} className="sm:hidden">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Change role</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={role.value}
            onValueChange={(next) => role.onChange?.(next as T)}
          >
            {role.levels.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </MoreMenu>
  );
}

// What removing someone asks, one description to a kind of subject. A person who stays in another
// way says how.
export function removalCopy(
  kind: "person" | "group" | "invite",
  name: string,
  stays?: string,
): { name: string; description: string } {
  return {
    name,
    description:
      kind === "invite"
        ? "The link stops working."
        : kind === "group"
          ? "Its people lose access unless they have it another way."
          : stays
            ? `They stay in through ${stays}.`
            : "They lose access.",
  };
}

// The × that removes someone from a list.
export function RemoveButton({
  name,
  disabled,
  onClick,
}: {
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <WithTooltip label="Remove">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${name}`}
        disabled={disabled}
        onClick={onClick}
      >
        <XIcon />
      </Button>
    </WithTooltip>
  );
}

// The question before removing someone, asked of the subject `removalCopy` made; closed when there
// is none.
export function RemoveConfirm({
  subject,
  onClose,
  onConfirm,
  error,
  disabled,
}: {
  subject: { name: string; description: string } | null;
  onClose: () => void;
  onConfirm: () => void;
  error?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <ConfirmDialog
      open={!!subject}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Remove ${subject?.name ?? ""}?`}
      description={subject?.description ?? ""}
      error={error}
      disabled={disabled}
      action="Remove"
      onConfirm={onConfirm}
    />
  );
}

// The controls of a row, side by side.
export function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}

// A surface's one primary action; on a phone, only its icon. It can be what opens a menu.
export function HeaderAction({
  icon,
  label,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & {
  icon: React.ReactNode;
  label: string;
  // Beside the label, as a menu's caret.
  children?: React.ReactNode;
}) {
  return (
    <Button aria-label={label} {...props}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
      {children}
    </Button>
  );
}
