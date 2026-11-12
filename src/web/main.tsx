import { QueryCache, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/web/shell/theme-provider";
import { SharedTooltip } from "@/web/components/with-tooltip";
import { Toaster } from "@/web/shell/toaster";
import { startTab } from "@/web/lib/org-tab";
import "@/web/lib/online";
import { onSessionLost } from "@/web/api/api-client";
import { cacheMaxAge, cacheOptions, cacheRestored, sessionReported } from "@/web/api/query-cache";
import { sessionQuery } from "@/web/auth/queries";
import { createAppRouter } from "@/web/app/router";

import "./index.css";

// A tab opened on a space or thread starts in that one's org.
await startTab();

// Cached queries stay in memory as long as the persisted cache may be restored.
// Whatever the server says of the session, whichever read of it that was, is acted on.
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onSuccess(data, query) {
      if (query.queryKey[0] !== "session") return;
      void sessionReported(
        queryClient,
        queryClient.getQueryData(sessionQuery.queryKey) ?? null,
        () => {
          void router.invalidate();
        },
      );
    },
  }),
  defaultOptions: { queries: { gcTime: cacheMaxAge } },
});
const router = createAppRouter(queryClient);
// A call the server refuses for want of a session asks about the session at once.
onSessionLost(() => void queryClient.fetchQuery(sessionQuery).catch(() => {}));

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
          <SharedTooltip />
        </Toaster>
      </PersistQueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
