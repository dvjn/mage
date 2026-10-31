import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody } from "@/server/http.ts";
import { type FolderSummary, folderNameSchema } from "@/shared/folders.ts";

import type { Folder, Folders } from "./service.ts";

function folderSummary(folder: Folder): FolderSummary {
  const { id, spaceId, name, createdAt, updatedAt } = folder;
  return {
    id,
    spaceId,
    name,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

const folderName = jsonBody(folderNameSchema, "A name of 1 to 80 characters is required");

export function folderRoutes(options: { folders: Folders }) {
  const { folders } = options;
  return new Hono<ApiEnv>()
    .get("/v1/spaces/:id/folders", (c) => {
      const list = folders.list(signedIn(c.var.principal), c.req.param("id"));
      return c.json(list.map(folderSummary), 200);
    })
    .post("/v1/spaces/:id/folders", folderName, (c) => {
      const { name } = c.req.valid("json");
      const folder = folders.create(signedIn(c.var.principal), c.req.param("id"), name);
      return c.json(folderSummary(folder), 200);
    })
    .patch("/v1/folders/:id", folderName, (c) => {
      const { name } = c.req.valid("json");
      const folder = folders.rename(signedIn(c.var.principal), c.req.param("id"), name);
      return c.json(folderSummary(folder), 200);
    })
    .delete("/v1/folders/:id", (c) => {
      folders.remove(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ ok: true }, 200);
    });
}
