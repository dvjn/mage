import { queryOptions } from "@tanstack/react-query";

import { meSchema } from "@/shared/me.ts";
import { signInOptionsSchema } from "@/shared/sign-in.ts";
import { apiClient } from "@/web/api/api-client";
import { authClient } from "@/web/api/auth-client";
import { adoptOrg } from "@/web/lib/org-tab";

// They change only when the server restarts.
export const signInOptionsQuery = queryOptions({
  queryKey: ["sign-in-options"],
  staleTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const res = await apiClient["sign-in-options"].$get();
    if (!res.ok) throw new Error("could not read the ways to sign in");
    return signInOptionsSchema.parse(await res.json());
  },
});

// Asked for even offline, so that pages waiting on it learn at once that the server cannot be
// reached.
export const sessionQuery = queryOptions({
  queryKey: ["session"],
  networkMode: "always",
  queryFn: async () => {
    const { data, error } = await authClient.getSession();
    if (error) throw new Error(error.message ?? "could not read the session");
    return data;
  },
});

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => {
    const res = await apiClient.v1.me.$get();
    if (!res.ok) throw new Error("could not read the signed-in user");
    const me = meSchema.parse(await res.json());
    // A tab that named no org acts from now on in the one the server chose.
    adoptOrg(me.org.id);
    return me;
  },
});
