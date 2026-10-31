import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody, queryOf } from "@/server/http.ts";
import { pageParams } from "@/shared/paging.ts";
import {
  orgSpaceFilterSchema,
  setEveryoneSchema,
  setSpaceMemberSchema,
  spaceDefaultsSchema,
  spaceMemberFilterSchema,
  type SpaceSummary,
  spaceNameSchema,
} from "@/shared/spaces.ts";

import type { Spaces, SpaceView } from "./service.ts";

function spaceSummary(space: SpaceView): SpaceSummary {
  const { id, kind, name, primary, role, manage, everyoneRole, defaultModel, defaultEffort } =
    space;
  return {
    id,
    kind,
    name,
    primary,
    role,
    manage,
    everyoneRole,
    defaultModel,
    defaultEffort,
    createdAt: space.createdAt.toISOString(),
  };
}

const spaceName = jsonBody(spaceNameSchema, "A name of 1 to 80 characters is required");

const spaceDefaults = jsonBody(
  spaceDefaultsSchema,
  "Give a model ref or null, or an effort of low, medium, high or null",
);

const setSpaceMember = jsonBody(
  setSpaceMemberSchema,
  "Give a user or group id and a role of owner, messager, viewer or null",
);

const setEveryone = jsonBody(setEveryoneSchema, "role is messager, viewer or null");

const orgSpaceQuery = queryOf(orgSpaceFilterSchema);

const spaceMemberQuery = queryOf(spaceMemberFilterSchema);

export function spaceRoutes(options: { spaces: Spaces }) {
  const { spaces } = options;
  return new Hono<ApiEnv>()
    .get("/v1/org/spaces", orgSpaceQuery, (c) => {
      const { kind, everyone, ...query } = c.req.valid("query");
      const page = spaces.catalog(signedIn(c.var.principal), {
        ...pageParams(query),
        ...(kind && { kind }),
        ...(everyone && { everyone }),
      });
      return c.json(
        {
          ...page,
          items: page.items.map(({ ownerName, memberCount, hasThreads, ...space }) => ({
            ...spaceSummary(space),
            ownerName,
            memberCount,
            hasThreads,
          })),
        },
        200,
      );
    })
    .get("/v1/spaces", (c) => {
      return c.json(spaces.list(signedIn(c.var.principal)).map(spaceSummary), 200);
    })
    .post("/v1/spaces", spaceName, (c) => {
      const space = spaces.create(signedIn(c.var.principal), c.req.valid("json").name);
      return c.json(spaceSummary(space), 200);
    })
    .patch("/v1/spaces/:id", spaceName, (c) => {
      const { name } = c.req.valid("json");
      const space = spaces.rename(signedIn(c.var.principal), c.req.param("id"), name);
      return c.json(spaceSummary(space), 200);
    })
    .patch("/v1/spaces/:id/defaults", spaceDefaults, async (c) => {
      const changes = c.req.valid("json");
      const space = await spaces.setDefaults(signedIn(c.var.principal), c.req.param("id"), changes);
      return c.json(spaceSummary(space), 200);
    })
    .delete("/v1/spaces/:id", (c) => {
      spaces.remove(signedIn(c.var.principal), c.req.param("id"));
      return c.json({ ok: true }, 200);
    })
    .get("/v1/spaces/:id/members", spaceMemberQuery, (c) => {
      const { role, ...query } = c.req.valid("query");
      const params = { ...pageParams(query), ...(role && { role }) };
      return c.json(spaces.members(signedIn(c.var.principal), c.req.param("id"), params), 200);
    })
    .put("/v1/spaces/:id/members", setSpaceMember, (c) => {
      const { kind, id, role } = c.req.valid("json");
      spaces.setMember(signedIn(c.var.principal), c.req.param("id"), { kind, id }, role);
      return c.json({ ok: true }, 200);
    })
    .put("/v1/spaces/:id/everyone", setEveryone, (c) => {
      const { role } = c.req.valid("json");
      const space = spaces.setEveryone(signedIn(c.var.principal), c.req.param("id"), role);
      return c.json(spaceSummary(space), 200);
    });
}
