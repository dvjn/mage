import { cpSync } from "node:fs";
import path from "node:path";

import devServer, { defaultOptions } from "@hono/vite-dev-server";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite-plus";

const here = import.meta.dirname;

// Code reaches another folder by its @/ path, so the import boundaries below see every crossing.
const outOfFolder = { regex: "^\\.\\./", message: "Import another folder's code by its @/ path." };
const webCode = { regex: "^@/web/", message: "Only the web client imports web code." };

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
        rolldownOptions: { input: path.join(here, "src/server/main.ts") },
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
        const from = path.join(here, "src/server/db/migrations");
        cpSync(from, path.join(here, "dist/server/migrations"), { recursive: true });
      },
    },
    devServer({
      entry: path.join(here, "src/server/main.ts"),
      // Hono answers /api; everything else falls through to Vite.
      exclude: [/^(?!\/api(\/|$|\?))/, ...defaultOptions.exclude],
      injectClientScript: false,
    }),
  ],
  // Migrations and the vendored marks are written by tools, as they write them.
  fmt: { ignorePatterns: ["src/server/db/migrations/**", "src/web/icons/marks.ts"] },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        // Shared code is the contract between the web client and the server, and needs neither.
        files: ["src/shared/**"],
        excludeFiles: ["**/*.test.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                outOfFolder,
                { regex: "^@/(server|web)/", message: "Shared code imports only shared code." },
              ],
            },
          ],
        },
      },
      {
        // The client reaches the server only through the API, typed by its routes.
        files: ["src/web/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "@/server/app.ts",
                  allowTypeImports: true,
                  message: "The web client takes only the Api type from the server.",
                },
              ],
              patterns: [
                {
                  regex: "^@/server/[^/]+/|^@/server/(main|http|schema)\\.ts$",
                  message: "The web client imports only web code and shared/.",
                },
              ],
            },
          ],
        },
      },
      {
        // A feature reaches another through its service: only the entry point wires stores, and
        // only the app mounts routes.
        files: ["src/server/**"],
        excludeFiles: [
          "src/server/main.ts",
          "src/server/app.ts",
          "src/server/testing/**",
          "**/*.test.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                outOfFolder,
                webCode,
                {
                  regex: "^@/server/[^/]+/([^/]+-)?store\\.ts$",
                  message: "Use the feature's service; only the entry point wires stores.",
                },
                {
                  regex: "^@/server/[^/]+/routes\\.ts$",
                  message: "Only the app mounts a feature's routes.",
                },
              ],
            },
          ],
        },
      },
      {
        // The platform knows no feature.
        files: ["src/server/kernel/**", "src/server/db/**"],
        excludeFiles: ["**/*.test.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                outOfFolder,
                webCode,
                { regex: "^@/server/", message: "The kernel and the database import no feature." },
              ],
            },
          ],
        },
      },
    ],
  },
  test: {
    root: here,
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
