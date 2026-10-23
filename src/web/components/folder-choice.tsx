// Choosing a thread's folder, the one way everywhere: a menu of "No folder" and the space's
// folders, the current one checked.

import { CheckIcon } from "lucide-react";

import type { FolderSummary } from "@/shared/folders.ts";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";

export const NO_FOLDER = "No folder";

export function FolderChoices({
  folders,
  value,
  onChange,
}: {
  folders: FolderSummary[];
  value: string | null;
  onChange: (folderId: string | null) => void;
}) {
  return [{ id: null, name: NO_FOLDER }, ...folders].map((option) => (
    <DropdownMenuItem key={option.id ?? "none"} onClick={() => onChange(option.id)}>
      <span className="truncate">{option.name}</span>
      {option.id === value && <CheckIcon className="ml-auto" aria-label="Current" />}
    </DropdownMenuItem>
  ));
}
