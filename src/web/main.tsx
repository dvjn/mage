import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/web/app/theme-provider";
import { Toaster } from "@/web/app/toaster";
import { startTab } from "@/web/lib/org-tab";
import "@/web/lib/online";
import { cacheMaxAge, cacheOptions, cacheRestored } from "@/web/lib/query-cache";
import { createAppRouter } from "@/web/app/router";

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
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={cacheOptions(queryClient)}
        onSuccess={cacheRestored}
        onError={cacheRestored}
      >
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </PersistQueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
