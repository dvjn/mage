// Folders kept in the folder table, with ULID ids.

import { asc, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Folder, FolderStore } from "@/ports/folders.ts";

import { type Db, writeLock } from "./db.ts";
import { folder, thread } from "./schema.ts";

const columns = {
  id: folder.id,
  spaceId: folder.spaceId,
  name: folder.name,
  createdBy: folder.createdBy,
  createdAt: folder.createdAt,
  updatedAt: folder.updatedAt,
};

export function createFolderStore(db: Db): FolderStore {
  return {
    create(input) {
      return db
        .insert(folder)
        .values({ id: ulid(), ...input })
        .returning(columns)
        .get();
    },

    find(id): Folder | null {
      return db.select(columns).from(folder).where(eq(folder.id, id)).get() ?? null;
    },

    listInSpace(spaceId) {
      return db
        .select(columns)
        .from(folder)
        .where(eq(folder.spaceId, spaceId))
        .orderBy(asc(folder.name), asc(folder.id))
        .all();
    },

    rename(id, name) {
      return db
        .update(folder)
        .set({ name, updatedAt: new Date() })
        .where(eq(folder.id, id))
        .returning(columns)
        .get() as Folder;
    },

    delete(id) {
      db.transaction((tx) => {
        tx.update(thread).set({ folderId: null }).where(eq(thread.folderId, id)).run();
        tx.delete(folder).where(eq(folder.id, id)).run();
      }, writeLock);
    },
  };
}
