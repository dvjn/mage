import { Hono } from "hono";

import { type ApiEnv, signedIn, checkedBody } from "@/server/http.ts";
import { instructionsInputSchema } from "@/shared/instructions.ts";

import type { Instructions } from "./service.ts";

const instructionsInput = checkedBody(instructionsInputSchema);

export function instructionRoutes(options: { instructions: Instructions }) {
  const { instructions } = options;
  return new Hono<ApiEnv>()
    .get("/v1/org/instructions", (c) => {
      return c.json(instructions.inOrg(signedIn(c.var.principal)), 200);
    })
    .put("/v1/org/instructions", instructionsInput, (c) => {
      const principal = signedIn(c.var.principal);
      return c.json(instructions.setInOrg(principal, c.req.valid("json").text), 200);
    })
    .get("/v1/spaces/:id/instructions", (c) => {
      return c.json(instructions.inSpace(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .put("/v1/spaces/:id/instructions", instructionsInput, (c) => {
      const principal = signedIn(c.var.principal);
      return c.json(
        instructions.setInSpace(principal, c.req.param("id"), c.req.valid("json").text),
        200,
      );
    });
}
