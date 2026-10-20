// Folders group a space's threads; a thread in no folder is at the top of the space.

export interface Folder {
  id: string;
  spaceId: string;
  name: string;
  // Null once the user who made it is gone.
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderStore {
  create(folder: { spaceId: string; name: string; createdBy: string }): Folder;
  find(id: string): Folder | null;
  // By name.
  listInSpace(spaceId: string): Folder[];
  rename(id: string, name: string): Folder;
  // Moves the folder's threads to the top of the space, then deletes it, in one transaction.
  delete(id: string): void;
}
