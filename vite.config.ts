import { cpSync } from "node:fs";
import path from "node:path";

import devServer, { defaultOptions } from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";

const here = import.meta.dirname;

export default defineConfig({
  root: path.join(here, "src/web"),
  resolve: {
    alias: { "@": path.join(here, "src") },
  },
  server: { port: 4783 },
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  build: {
    outDir: path.join(here, "dist/web"),
    emptyOutDir: true,
  },
  // A build covers every environment: the client above and this server bundle.
  builder: {},
  environments: {
    ssr: {
      build: {
        outDir: path.join(here, "dist/server"),
        emptyOutDir: true,
        sourcemap: true,
        rolldownOptions: { input: path.join(here, "src/main.ts") },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    // A service worker keeps the client's own files, so it opens without a network; each build's
    // replaces the last one's as soon as it is seen. It never answers for the API.
    ...VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{html,js,css,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api(\/|$)/],
      },
    }).map((plugin) => ({
      ...plugin,
      applyToEnvironment: (environment: { name: string }) => environment.name === "client",
    })),
    {
      // The server bundle applies migrations from the folder next to it.
      name: "copy-migrations",
      applyToEnvironment: (environment) => environment.name === "ssr",
      writeBundle() {
        const from = path.join(here, "src/adapters/migrations");
        cpSync(from, path.join(here, "dist/server/migrations"), { recursive: true });
      },
    },
    devServer({
      entry: path.join(here, "src/main.ts"),
      // Hono answers /api; everything else falls through to Vite.
      exclude: [/^(?!\/api(\/|$|\?))/, ...defaultOptions.exclude],
      injectClientScript: false,
    }),
  ],
  fmt: { ignorePatterns: ["src/adapters/migrations/**"] },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    root: here,
    include: ["test/**/*.test.ts"],
  },
});
