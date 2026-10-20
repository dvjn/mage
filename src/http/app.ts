// API routes under /api and, in production, the built web client.

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

export interface AppOptions {
  // Directory holding the built web client. Unset in dev, where Vite serves it.
  webRoot?: string;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (options.webRoot) {
    const indexHtml = serveStatic({ root: options.webRoot, path: "index.html" });
    app.use("*", serveStatic({ root: options.webRoot }));
    // Extensionless paths are client routes; a missing file with an extension is a 404.
    app.get("*", async (c, next) =>
      /\.[^/]*$/.test(c.req.path) ? c.notFound() : indexHtml(c, next),
    );
  }

  return app;
}
