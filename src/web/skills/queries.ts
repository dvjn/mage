import { queryOptions } from "@tanstack/react-query";

import { orgSkillListSchema, skillDetailSchema, spaceSkillListSchema } from "@/shared/skills.ts";
import { apiClient } from "@/web/api/api-client";

export const orgSkillsQuery = queryOptions({
  queryKey: ["skills", "org"],
  queryFn: async () => {
    const res = await apiClient.v1.org.skills.$get();
    if (!res.ok) throw new Error("could not read the skills");
    return orgSkillListSchema.parse(await res.json());
  },
});

export function spaceSkillsQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["skills", "space", spaceId],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"].skills.$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the space's skills");
      return spaceSkillListSchema.parse(await res.json());
    },
  });
}

export function skillQuery(id: string) {
  return queryOptions({
    queryKey: ["skills", "one", id],
    queryFn: async () => {
      const res = await apiClient.v1.skills[":id"].$get({ param: { id } });
      if (!res.ok) throw new Error("could not read the skill");
      return skillDetailSchema.parse(await res.json());
    },
  });
}
