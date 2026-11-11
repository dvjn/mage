// Artifact routes on the app's origin: listing the ones a person can open and a thread's, reading one, getting a link to
// view it, changing its sharing, deleting it, following its changes, and the settings on making them public.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { type ApiEnv, checkedBody, queryOf, signedIn } from "@/server/http.ts";
import {
  artifactListQuerySchema,
  artifactSettingsChangeSchema,
  artifactSharingChangeSchema,
  artifactViewRequestSchema,
} from "@/shared/artifacts.ts";

import type { Artifacts } from "./service.ts";

const listQuery = queryOf(artifactListQuerySchema);
const viewRequest = checkedBody(artifactViewRequestSchema);
const sharingChange = checkedBody(artifactSharingChangeSchema);
const settingsChange = checkedBody(artifactSettingsChangeSchema);

// How often a stream checks the viewer may still view the artifact, and keeps the connection open.
const HEARTBEAT_MS = 15_000;

export function artifactRoutes(options: {
  artifacts: Artifacts;
  heartbeatMs?: number;
  shutdown?: AbortSignal;
}) {
  const { artifacts } = options;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  return new Hono<ApiEnv>()
    .get("/v1/threads/:id/artifacts", (c) => {
      return c.json(artifacts.inThread(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .get("/v1/artifacts", listQuery, (c) => {
      return c.json(artifacts.list(signedIn(c.var.principal), c.req.valid("query")), 200);
    })
    .get("/v1/artifacts/:id", (c) => {
      return c.json(artifacts.detail(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .delete("/v1/artifacts/:id", (c) => {
      artifacts.delete(signedIn(c.var.principal), c.req.param("id"));
      return c.body(null, 204);
    })
    .post("/v1/artifacts/:id/view", viewRequest, async (c) => {
      const principal = signedIn(c.var.principal);
      return c.json(await artifacts.view(principal, c.req.param("id"), c.req.valid("json")), 200);
    })
    .put("/v1/artifacts/:id/sharing", sharingChange, (c) => {
      const principal = signedIn(c.var.principal);
      const { sharing } = c.req.valid("json");
      return c.json(artifacts.setSharing(principal, c.req.param("id"), sharing), 200);
    })
    .get("/v1/artifacts/:id/events", (c) => {
      const principal = signedIn(c.var.principal);
      const id = c.req.param("id");
      // Answers 404 before the stream starts.
      artifacts.detail(principal, id);
      return streamSSE(c, async (stream) => {
        let writing = Promise.resolve();
        const unsubscribe = artifacts.follow(principal, id, (event) => {
          writing = writing.then(() =>
            stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
          );
        });
        stream.onAbort(unsubscribe);
        while (!stream.aborted && !options.shutdown?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
          if (stream.aborted || options.shutdown?.aborted) break;
          // Whoever may no longer view it is told so, and the stream ends.
          if (!artifacts.viewable(principal, id)) {
            await writing;
            await stream.writeSSE({ event: "access-ended", data: "{}" });
            break;
          }
          writing = writing.then(() => stream.write(": heartbeat\n\n").then(() => {}));
          await writing;
        }
        unsubscribe();
      });
    })
    .get("/v1/org/artifacts/settings", (c) => {
      return c.json(artifacts.orgSettings(signedIn(c.var.principal)), 200);
    })
    .put("/v1/org/artifacts/settings", settingsChange, (c) => {
      const principal = signedIn(c.var.principal);
      return c.json(artifacts.setOrgSettings(principal, c.req.valid("json").publicAllowed), 200);
    })
    .get("/v1/spaces/:id/artifacts/settings", (c) => {
      return c.json(artifacts.spaceSettings(signedIn(c.var.principal), c.req.param("id")), 200);
    })
    .put("/v1/spaces/:id/artifacts/settings", settingsChange, (c) => {
      const principal = signedIn(c.var.principal);
      const { publicAllowed } = c.req.valid("json");
      return c.json(artifacts.setSpaceSettings(principal, c.req.param("id"), publicAllowed), 200);
    });
}
