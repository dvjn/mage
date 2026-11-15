// The contract with the web client, kept as a file so that any change to it shows as a diff: every
// route the server answers, every schema the two share, and every event of the live streams.

import { agentThread } from "@/server/testing/agent-thread.ts";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { setup } from "@/server/testing/workspace.ts";
import { STREAMS } from "@/shared/streams.ts";

const SNAPSHOT = "../shared/contract.snapshot.json";

const modules = import.meta.glob<Record<string, unknown>>(
  ["../shared/**/*.ts", "!../shared/**/*.test.ts"],
  { eager: true },
);

// Every schema the shared modules export, by its module and name, and the streams' events. One
// schema used inside another is named there, not repeated.
function schemas() {
  const registry = z.registry<{ id: string }>();
  for (const [file, exports] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const module = file.replace("../shared/", "");
    for (const [name, value] of Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))) {
      if (!name.endsWith("Schema") || !(value instanceof z.ZodType)) continue;
      // A schema exported under a second name keeps its first.
      if (!registry.has(value)) registry.add(value, { id: `${module}#${name}` });
    }
  }
  for (const [name, stream] of Object.entries(STREAMS)) {
    for (const [event, schema] of Object.entries(stream.events)) {
      if (!registry.has(schema)) registry.add(schema, { id: `stream:${name}:${event}` });
    }
  }
  const { schemas } = z.toJSONSchema(registry, {
    unrepresentable: "any",
    io: "input",
    uri: (id) => id,
  });
  for (const shape of Object.values(schemas)) delete shape.$schema;
  return {
    schemas,
    idOf: (schema: z.ZodType) => registry.get(schema)?.id,
  };
}

async function routes() {
  const { app } = setup();
  const seen = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
  // The routes tests arrange data through are no part of what the web client is told.
  return [...seen].filter((route) => !route.includes(" /api/test/")).sort();
}

function streams(idOf: (schema: z.ZodType) => string | undefined) {
  return Object.fromEntries(
    Object.entries(STREAMS).map(([name, stream]) => [
      name,
      {
        path: stream.path,
        events: Object.fromEntries(
          Object.entries(stream.events).map(([event, schema]) => [event, idOf(schema)]),
        ),
      },
    ]),
  );
}

describe("the contract with the web client", () => {
  it("is what the snapshot holds", async () => {
    const { schemas: shapes, idOf } = schemas();
    const contract = { routes: await routes(), streams: streams(idOf), schemas: shapes };
    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot(SNAPSHOT);
  });

  it("answers the paths it no longer has as not found", async () => {
    const t = await agentThread();
    for (const path of [
      "/inbox/events",
      `/threads/${t.thread.id}/background`,
      `/threads/${t.thread.id}/triggers/x/history`,
    ]) {
      expect((await t.api("GET", path, t.ada.cookie)).status).toBe(404);
    }
    expect(
      (await t.api("POST", `/threads/${t.thread.id}/background/seen`, t.ada.cookie, {})).status,
    ).toBe(404);
  });

  it("has a route for every stream", async () => {
    const paths = new Set(await routes());
    for (const stream of Object.values(STREAMS)) {
      expect(paths).toContain(`GET /api${stream.path}`);
    }
  });
});
