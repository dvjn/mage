import { queryOptions } from "@tanstack/react-query";

import { agentNameSchema, orgListSchema, teamSettingsSchema } from "@/shared/orgs.ts";
import { apiClient } from "@/web/api/api-client";

// The orgs the signed-in user is in, and whether they may create a team org.
export const orgsQuery = queryOptions({
  queryKey: ["orgs"],
  queryFn: async () => {
    const res = await apiClient.v1.orgs.$get();
    if (!res.ok) throw new Error("could not read your organizations");
    return orgListSchema.parse(await res.json());
  },
});

// What the agent of the org's threads goes by.
export const agentNameQuery = queryOptions({
  queryKey: ["agent-name"],
  queryFn: async () => {
    const res = await apiClient.v1.org.agent.$get();
    if (!res.ok) throw new Error("could not read the agent's name");
    return agentNameSchema.parse(await res.json());
  },
});

export const teamSettingsQuery = queryOptions({
  queryKey: ["team-settings"],
  queryFn: async () => {
    const res = await apiClient.v1.org.settings.$get();
    if (!res.ok) throw new Error("could not read the organization's settings");
    return teamSettingsSchema.parse(await res.json());
  },
});
