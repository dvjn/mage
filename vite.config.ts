import path from "node:path";

import devServer, { defaultOptions } from "@hono/vite-dev-server";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const here = import.meta.dirname;

export default defineConfig({
  root: path.join(here, "src/web"),
  resolve: {
    alias: { "@": path.join(here, "src") },
  },
  server: { port: 4783 },
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
    devServer({
      entry: path.join(here, "src/main.ts"),
      // Hono answers /api; everything else falls through to Vite.
      exclude: [/^(?!\/api(\/|$|\?))/, ...defaultOptions.exclude],
      injectClientScript: false,
    }),
  ],
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
