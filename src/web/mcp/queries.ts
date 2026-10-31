import { queryOptions } from "@tanstack/react-query";

import { mcpServerSchema, orgMcpServersSchema, spaceMcpServersSchema } from "@/shared/mcp.ts";
import { apiClient } from "@/web/api/api-client";

export const orgMcpServersQuery = queryOptions({
  queryKey: ["mcp-servers", "org"],
  queryFn: async () => {
    const res = await apiClient.v1.org["mcp-servers"].$get();
    if (!res.ok) throw new Error("could not read the MCP servers");
    return orgMcpServersSchema.parse(await res.json());
  },
});

export function spaceMcpServersQuery(spaceId: string) {
  return queryOptions({
    queryKey: ["mcp-servers", "space", spaceId],
    queryFn: async () => {
      const res = await apiClient.v1.spaces[":id"]["mcp-servers"].$get({ param: { id: spaceId } });
      if (!res.ok) throw new Error("could not read the space's MCP servers");
      return spaceMcpServersSchema.parse(await res.json());
    },
  });
}

export function mcpServerQuery(id: string) {
  return queryOptions({
    queryKey: ["mcp-servers", "one", id],
    queryFn: async () => {
      const res = await apiClient.v1["mcp-servers"][":id"].$get({ param: { id } });
      if (!res.ok) throw new Error("could not read the MCP server");
      return mcpServerSchema.parse(await res.json());
    },
  });
}
