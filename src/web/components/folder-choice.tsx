// Choosing a thread's folder, the one way everywhere: a searchable list with "No folder" pinned at
// the top, the space's folders, the current one checked, and "New folder" at the bottom, which
// makes a folder and chooses it. It opens from a breadcrumb or a button, or as a dialog from a menu.

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, FolderIcon, FolderPlusIcon } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import { folderSchema, type FolderSummary } from "@/shared/folders.ts";
import type { Crumb } from "@/web/components/app-shell";
import { NameDialog } from "@/web/components/name-dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/web/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { WithTooltip } from "@/web/components/with-tooltip";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { spaceFoldersQuery } from "@/web/lib/queries";

export const NO_FOLDER = "No folder";

// The list itself; `onNew` asks for a new folder, with the text typed so far as its name.
function FolderList({
  folders,
  value,
  onChange,
  onNew,
}: {
  folders: FolderSummary[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  onNew: (name: string) => void;
}) {
  const [text, setText] = useState("");
  // The item's own check shows on the current one.
  const checked = (id: string | null) => id === value || undefined;
  return (
    <Command
      // "No folder" and "New folder" stay whatever is typed.
      filter={(itemValue, search) =>
        itemValue === "\u0000none" ||
        itemValue === "\u0000new" ||
        itemValue.toLowerCase().includes(search.toLowerCase())
          ? 1
          : 0
      }
    >
      <CommandInput placeholder="Find a folder" value={text} onValueChange={setText} />
      <CommandList>
        <CommandEmpty>No folder matches.</CommandEmpty>
        <CommandGroup>
          <CommandItem
            value={"\u0000none"}
            data-checked={checked(null)}
            onSelect={() => onChange(null)}
          >
            {NO_FOLDER}
          </CommandItem>
          {folders.map((folder) => (
            <CommandItem
              key={folder.id}
              value={`${folder.name}\u0000${folder.id}`}
              data-checked={checked(folder.id)}
              onSelect={() => onChange(folder.id)}
            >
              <span className="truncate">{folder.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem value={"\u0000new"} onSelect={() => onNew(text.trim())}>
            <FolderPlusIcon />
            New folder
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

// Making a folder in the space from the list, then choosing it.
function useNewFolder(spaceId: string, onChange: (folderId: string | null) => void) {
  const queryClient = useQueryClient();
  const [naming, setNaming] = useState<string | null>(null);
  async function create(name: string) {
    const res = await apiClient.v1.spaces[":id"].folders.$post({
      param: { id: spaceId },
      json: { name },
    });
    if (!res.ok) return errorOf(res);
    const folder = folderSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spaceFoldersQuery(spaceId).queryKey });
    onChange(folder.id);
    return undefined;
  }
  const dialog = (
    <NameDialog
      key={naming ?? "new-folder"}
      title="New folder"
      action="Create"
      initialName={naming ?? ""}
      open={naming !== null}
      onOpenChange={(open) => !open && setNaming(null)}
      onSubmit={create}
    />
  );
  return { ask: (name: string) => setNaming(name), dialog };
}

// The list in a popover beside its trigger.
export function FolderPicker({
  spaceId,
  folders,
  value,
  onChange,
  trigger,
  tooltip,
  children,
}: {
  spaceId: string;
  folders: FolderSummary[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  trigger: React.ReactElement;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const fresh = useNewFolder(spaceId, onChange);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {tooltip ? (
          <WithTooltip label={tooltip}>
            <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
          </WithTooltip>
        ) : (
          <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
        )}
        <PopoverContent align="start" className="w-56 p-0">
          <FolderList
            folders={folders}
            value={value}
            onChange={(id) => {
              setOpen(false);
              onChange(id);
            }}
            onNew={(name) => {
              setOpen(false);
              fresh.ask(name);
            }}
          />
        </PopoverContent>
      </Popover>
      {fresh.dialog}
    </>
  );
}

// The list in a dialog, for a menu that cannot hold it.
export function FolderPickerDialog({
  spaceId,
  title,
  folders,
  value,
  open,
  onOpenChange,
  onChange,
}: {
  spaceId: string;
  title: string;
  folders: FolderSummary[];
  value: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (folderId: string | null) => void;
}) {
  const fresh = useNewFolder(spaceId, onChange);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-3 p-0 sm:max-w-sm">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Move {title}</DialogTitle>
            <DialogDescription>Choose the folder it goes in.</DialogDescription>
          </DialogHeader>
          <div className="border-t">
            <FolderList
              folders={folders}
              value={value}
              onChange={(id) => {
                onOpenChange(false);
                onChange(id);
              }}
              onNew={(name) => {
                onOpenChange(false);
                fresh.ask(name);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      {fresh.dialog}
    </>
  );
}

// The breadcrumb that stands for a thread's folder, between its space and its title. Whoever may
// move the thread gets a folder icon and the folder's name with a chevron, or the icon and chevron
// alone to add it to one; anyone else the folder's name, or nothing.
export function folderCrumb({
  spaceId,
  folders,
  value,
  onChange,
  canMove,
}: {
  spaceId: string;
  folders: FolderSummary[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  canMove: boolean;
}): Crumb | null {
  const current = folders.find((folder) => folder.id === value);
  if (!canMove) return current ? { label: current.name } : null;
  const picker = (trigger: React.ReactElement, children: React.ReactNode, tooltip?: string) => (
    <FolderPicker
      spaceId={spaceId}
      folders={folders}
      value={current?.id ?? null}
      onChange={onChange}
      trigger={trigger}
      {...(tooltip && { tooltip })}
    >
      {children}
    </FolderPicker>
  );
  // Looks like the crumbs beside it: muted text that brightens on hover.
  const crumb = (label: string) => (
    <button
      type="button"
      aria-label={label}
      className="inline-flex max-w-48 items-center gap-1 rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
    />
  );
  if (!current) {
    return {
      label: "Add to folder",
      control: picker(
        crumb("Add to folder"),
        <>
          <FolderIcon />
          <ChevronDownIcon />
        </>,
        "Add to folder",
      ),
    };
  }
  return {
    label: current.name,
    control: picker(
      crumb(`Folder: ${current.name}`),
      <>
        <FolderIcon />
        <span className="truncate">{current.name}</span>
        <ChevronDownIcon />
      </>,
    ),
  };
}
