import { cpSync, readdirSync } from "node:fs";
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

// The client reaches the server only through the API, typed by its routes. Every rule on web code
// repeats this, since an override's rule replaces an earlier one's.
const serverApiType = {
  name: "@/server/app.ts",
  allowTypeImports: true,
  message: "The web client takes only the Api type from the server.",
};
const serverCode = {
  regex: "^@/server/[^/]+/|^@/server/(main|http|schema)\\.ts$",
  message: "The web client imports only web code and shared/.",
};
type Pattern = { regex: string; message: string } | { group: string[]; message: string };
function webImports(
  ...patterns: Pattern[]
): ["error", { paths: (typeof serverApiType)[]; patterns: Pattern[] }] {
  return ["error", { paths: [serverApiType], patterns: [serverCode, ...patterns] }];
}
// Web code may import only the given web folders.
function onlyWeb(folders: string[], message: string): Pattern {
  return { group: ["@/web/**", ...folders.map((folder) => `!@/web/${folder}/**`)], message };
}

// The web client's layers; every other folder is a feature.
const webLayers = ["api", "app", "components", "hooks", "icons", "lib", "public", "shell"];
const webFeatures = readdirSync(path.join(here, "src/web"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !webLayers.includes(entry.name))
  .map((entry) => entry.name);

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
        files: ["src/web/**"],
        rules: { "no-restricted-imports": webImports() },
      },
      {
        // Components know nothing of Mage, so any app could take them.
        files: ["src/web/components/**"],
        rules: {
          "no-restricted-imports": webImports(
            onlyWeb(
              ["components", "lib", "hooks", "icons"],
              "Components import only components, lib, hooks and icons.",
            ),
          ),
        },
      },
      {
        // The shell is Mage's chrome and page vocabulary, and holds no feature's data.
        files: ["src/web/shell/**"],
        rules: {
          "no-restricted-imports": webImports(
            onlyWeb(
              ["components", "lib", "hooks", "icons", "api", "shell"],
              "The shell imports only components, lib, hooks, icons, api and shell.",
            ),
          ),
        },
      },
      {
        files: ["src/web/lib/**", "src/web/hooks/**"],
        rules: {
          "no-restricted-imports": webImports(
            onlyWeb(["lib", "hooks"], "Lib and hooks import only lib and hooks."),
          ),
        },
      },
      // Only the app wires features together; a feature may read another's queries, but not change
      // its data.
      ...webFeatures.map((feature) => ({
        files: [`src/web/${feature}/**`],
        rules: {
          "no-restricted-imports": webImports(
            { group: ["@/web/app/**"], message: "Features never import the app's wiring." },
            {
              group: ["@/web/*/mutations", `!@/web/${feature}/mutations`],
              message: "Use another feature's queries, not its mutations.",
            },
          ),
        },
      })),
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
