// Folders in the spaces a person can see: listing, making and renaming them, and deleting them
// with their threads moved to the top of the space.

import type { Folder, FolderStore } from "@/ports/folders.ts";
import type { Principal } from "@/ports/identity.ts";
import { ServiceError } from "@/services/errors.ts";
import type { Spaces } from "@/services/spaces.ts";

export interface FoldersOptions {
  spaces: Spaces;
  folders: FolderStore;
}

export type Folders = ReturnType<typeof createFolders>;

export function createFolders(options: FoldersOptions) {
  const { spaces, folders } = options;

  // The folder when the principal can see its space; otherwise it is not found.
  function visible(principal: Principal, id: string): Folder {
    const folder = folders.find(id);
    if (!folder || !spaces.findVisible(principal, folder.spaceId)) {
      throw new ServiceError(404, "Folder not found");
    }
    return folder;
  }

  return {
    // Checks that a folder id names a folder in the space; null is the top of the space.
    requireIn(spaceId: string, folderId: string | null) {
      if (folderId !== null && folders.find(folderId)?.spaceId !== spaceId) {
        throw new ServiceError(400, "That folder is not in this space");
      }
    },

    list(principal: Principal, spaceId: string) {
      spaces.visible(principal, spaceId);
      return folders.listInSpace(spaceId);
    },

    create(principal: Principal, spaceId: string, name: string) {
      spaces.visible(principal, spaceId);
      return folders.create({ spaceId, name, createdBy: principal.userId });
    },

    rename(principal: Principal, id: string, name: string) {
      visible(principal, id);
      return folders.rename(id, name);
    },

    // Its threads move to the top of the space.
    remove(principal: Principal, id: string) {
      visible(principal, id);
      folders.delete(id);
    },
  };
}
