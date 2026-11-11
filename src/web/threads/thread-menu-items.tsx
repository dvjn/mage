// The items of a thread's menu, in one order wherever it shows: the sidebar's row and the thread's
// header. Each shows only when its action is given; the delete item is set apart.

import {
  ArchiveRestoreIcon,
  ArrowRightLeftIcon,
  LinkIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/web/components/ui/dropdown-menu";

export function ThreadMenuItems({
  onUnarchive,
  onRename,
  onMove,
  onCopyLink,
  onDelete,
}: {
  onUnarchive?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onCopyLink?: () => void;
  onDelete?: () => void;
}) {
  const others = onUnarchive || onRename || onMove || onCopyLink;
  return (
    <>
      {onUnarchive && (
        <DropdownMenuItem onClick={onUnarchive}>
          <ArchiveRestoreIcon />
          Unarchive
        </DropdownMenuItem>
      )}
      {onRename && (
        <DropdownMenuItem onClick={onRename}>
          <PencilIcon />
          Rename
        </DropdownMenuItem>
      )}
      {onMove && (
        <DropdownMenuItem onClick={onMove}>
          <ArrowRightLeftIcon />
          Move to space
        </DropdownMenuItem>
      )}
      {onCopyLink && (
        <DropdownMenuItem onClick={onCopyLink}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
      )}
      {onDelete && (
        <>
          {others && <DropdownMenuSeparator />}
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
