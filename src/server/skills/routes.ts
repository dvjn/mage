import { Hono } from "hono";

import { type ApiEnv, signedIn, jsonBody, checkedBody } from "@/server/http.ts";
import {
  newSkillSourceSchema,
  skillEnabledChangeSchema,
  skillInputSchema,
  skillTokenChangeSchema,
  skillUploadSchema,
  spaceSkillsChangeSchema,
} from "@/shared/skills.ts";

import type { Skills } from "./service.ts";

const newSkillSource = checkedBody(newSkillSourceSchema);

const skillInput = checkedBody(skillInputSchema);

const skillTokenChange = checkedBody(skillTokenChangeSchema);

const skillUpload = checkedBody(skillUploadSchema);

const skillEnabledChange = jsonBody(skillEnabledChangeSchema, "enabled is true or false");

const spaceSkillsChange = jsonBody(spaceSkillsChangeSchema, "allowed is true or false");

export function skillRoutes(options: { skills: Skills }) {
  const { skills } = options;
  return (
    new Hono<ApiEnv>()
      .get("/v1/org/skills", async (c) => {
        return c.json(await skills.orgSkills(signedIn(c.var.principal)), 200);
      })
      .put("/v1/org/skills/space-skills", spaceSkillsChange, async (c) => {
        const principal = signedIn(c.var.principal);
        await skills.setSpaceSkills(principal, c.req.valid("json").allowed);
        return c.json(await skills.orgSkills(principal), 200);
      })
      .post("/v1/org/skill-sources", newSkillSource, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await skills.addSource(principal, null, c.req.valid("json")), 200);
      })
      .post("/v1/org/skills", skillInput, async (c) => {
        return c.json(
          await skills.write(signedIn(c.var.principal), null, c.req.valid("json")),
          200,
        );
      })
      .post("/v1/org/skills/upload", skillUpload, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await skills.upload(principal, null, c.req.valid("json")), 200);
      })
      .get("/v1/spaces/:id/skills", async (c) => {
        return c.json(await skills.spaceSkills(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .post("/v1/spaces/:id/skill-sources", newSkillSource, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(
          await skills.addSource(principal, c.req.param("id"), c.req.valid("json")),
          200,
        );
      })
      .post("/v1/spaces/:id/skills", skillInput, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await skills.write(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      .post("/v1/spaces/:id/skills/upload", skillUpload, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await skills.upload(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      // The space's switch on one of the org's sources.
      .put("/v1/spaces/:id/skill-sources/:sourceId", skillEnabledChange, async (c) => {
        const principal = signedIn(c.var.principal);
        const { id, sourceId } = c.req.param();
        await skills.setSpaceSource(principal, id, sourceId, c.req.valid("json").enabled);
        return c.json(await skills.spaceSkills(principal, id), 200);
      })
      // The space's switch on one of the org's skills.
      .put("/v1/spaces/:id/skills/:skillId", skillEnabledChange, async (c) => {
        const principal = signedIn(c.var.principal);
        const { id, skillId } = c.req.param();
        await skills.setSpaceSkill(principal, id, skillId, c.req.valid("json").enabled);
        return c.json(await skills.spaceSkills(principal, id), 200);
      })
      .put("/v1/skill-sources/:id/enabled", skillEnabledChange, async (c) => {
        const principal = signedIn(c.var.principal);
        await skills.setSourceEnabled(principal, c.req.param("id"), c.req.valid("json").enabled);
        return c.json({ ok: true }, 200);
      })
      .post("/v1/skill-sources/:id/refresh", async (c) => {
        return c.json(await skills.refresh(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .put("/v1/skill-sources/:id/token", skillTokenChange, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(
          await skills.setToken(principal, c.req.param("id"), c.req.valid("json").token),
          200,
        );
      })
      .delete("/v1/skill-sources/:id", async (c) => {
        await skills.removeSource(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
      .get("/v1/skills/:id", async (c) => {
        return c.json(await skills.get(signedIn(c.var.principal), c.req.param("id")), 200);
      })
      .patch("/v1/skills/:id", skillInput, async (c) => {
        const principal = signedIn(c.var.principal);
        return c.json(await skills.edit(principal, c.req.param("id"), c.req.valid("json")), 200);
      })
      .put("/v1/skills/:id/enabled", skillEnabledChange, async (c) => {
        const principal = signedIn(c.var.principal);
        await skills.setSkillEnabled(principal, c.req.param("id"), c.req.valid("json").enabled);
        return c.json({ ok: true }, 200);
      })
      .delete("/v1/skills/:id", async (c) => {
        await skills.remove(signedIn(c.var.principal), c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
  );
}
