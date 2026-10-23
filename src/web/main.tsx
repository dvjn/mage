import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/web/components/theme-provider";
import { Toaster } from "@/web/components/toaster";
import { startTab } from "@/web/lib/org-tab";
import { cacheMaxAge, cacheOptions } from "@/web/lib/query-cache";
import { createAppRouter } from "@/web/router";

import "./index.css";

// A tab opened on a space or thread starts in that one's org.
await startTab();

// Cached queries stay in memory as long as the persisted cache may be restored.
const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: cacheMaxAge } } });
const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system">
      <PersistQueryClientProvider client={queryClient} persistOptions={cacheOptions(queryClient)}>
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </PersistQueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
