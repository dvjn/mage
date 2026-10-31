// The sign-in client; a request that gets no answer takes the app offline.

import { createAuthClient } from "better-auth/react";

import { followServer } from "@/web/lib/online";

export const authClient = createAuthClient({
  fetchOptions: { customFetchImpl: followServer(fetch) },
});
