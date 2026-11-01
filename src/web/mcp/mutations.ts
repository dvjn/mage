// Changes to MCP servers: adding, changing, signing in with, reading again and removing one;
// switching one on or off for the org or space that owns it, or the org's for a space; and whether
// spaces add their own.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  mcpAuthorizeSchema,
  type McpAuthInput,
  mcpConnectResultSchema,
  type McpCredentialMode,
  mcpServerSchema,
  type McpServerSummary,
} from "@/shared/mcp.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { mcpServerQuery, orgMcpServersQuery, spaceMcpServersQuery } from "@/web/mcp/queries";
import type { Scope } from "@/web/shell/scope";

// A server's switch: its own, or for one of the org's in a space whether the space uses it.
export function useServerSwitch(scope: Scope) {
  const queryClient = useQueryClient();

  async function settled() {
    await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    await queryClient.invalidateQueries({ queryKey: ["org-tools"] });
    await queryClient.invalidateQueries({ queryKey: ["spaces"] });
  }

  const own = useMutation({
    mutationFn: async ({ server, enabled }: { server: McpServerSummary; enabled: boolean }) => {
      const res = await apiClient.v1["mcp-servers"][":id"].enabled.$put({
        param: { id: server.id },
        json: { enabled },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      queryClient.setQueryData(mcpServerQuery(server.id).queryKey, await res.json());
    },
    onSuccess: settled,
  });

  const inSpace = useMutation({
    mutationFn: async ({ server, enabled }: { server: McpServerSummary; enabled: boolean }) => {
      if (scope.kind !== "space") return;
      const res = await apiClient.v1.spaces[":id"]["mcp-servers"][":serverId"].$put({
        param: { id: scope.spaceId, serverId: server.id },
        json: { enabled },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      queryClient.setQueryData(spaceMcpServersQuery(scope.spaceId).queryKey, await res.json());
    },
    onSuccess: settled,
  });

  return {
    // What went wrong with the switch last turned.
    error: (own.error ?? inSpace.error)?.message,
    pending: own.isPending || inSpace.isPending,
    setEnabled: (server: McpServerSummary, enabled: boolean) => {
      inSpace.reset();
      own.mutate({ server, enabled });
    },
    setInSpace: (server: McpServerSummary, enabled: boolean) => {
      own.reset();
      inSpace.mutate({ server, enabled });
    },
  };
}

export function useSpaceServersAllowed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (allowed: boolean) => {
      const res = await apiClient.v1.org["mcp-servers"]["space-servers"].$put({
        json: { allowed },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      queryClient.setQueryData(orgMcpServersQuery.queryKey, await res.json());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp-servers", "space"] });
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
  });
}

// Sends the browser to authorize Mage with the server, or reads it again when it needed no one.
async function authorize(id: string) {
  const res = await apiClient.v1["mcp-servers"][":id"].authorize.$post({
    param: { id },
  });
  if (!res.ok) return { error: await errorOf(res) };
  const result = mcpAuthorizeSchema.parse(await res.json());
  if (result.status === "redirect") {
    window.location.assign(result.url);
    return { redirecting: true as const };
  }
  return { server: result.server };
}

async function serversChanged(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  await queryClient.invalidateQueries({ queryKey: ["org-tools"] });
  await queryClient.invalidateQueries({ queryKey: ["spaces"] });
}

// Adds a server to the org or a space, or changes one, answering it as saved.
export function useSaveServer(scope: Scope, serverId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: {
      name: string;
      slug?: string;
      url: string;
      auth: McpAuthInput;
      credentials: McpCredentialMode;
    }) => {
      const res = serverId
        ? await apiClient.v1["mcp-servers"][":id"].$patch({ param: { id: serverId }, json })
        : scope.kind === "org"
          ? await apiClient.v1.org["mcp-servers"].$post({ json })
          : await apiClient.v1.spaces[":id"]["mcp-servers"].$post({
              param: { id: scope.spaceId },
              json,
            });
      if (!res.ok) throw new Error(await errorOf(res));
      const saved = mcpServerSchema.parse(await res.json());
      queryClient.setQueryData(mcpServerQuery(saved.id).queryKey, saved);
      return saved;
    },
    onSuccess: () => serversChanged(queryClient),
  });
}

// Signs Mage in with the server: the browser leaves for its authorization server, so this stays
// pending, or, when it needed no one, the server is read again. A failure is the server's to show
// too, so it is read again then.
export function useAuthorizeServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (serverId: string) => {
      const result = await authorize(serverId);
      if ("redirecting" in result) return new Promise<never>(() => {});
      if ("error" in result) {
        await queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
        throw new Error(result.error);
      }
      queryClient.setQueryData(mcpServerQuery(serverId).queryKey, result.server);
    },
    onSuccess: () => serversChanged(queryClient),
  });
}

// Reads the server's tools again.
export function useRefreshServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (serverId: string) => {
      const res = await apiClient.v1["mcp-servers"][":id"].refresh.$post({
        param: { id: serverId },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      queryClient.setQueryData(
        mcpServerQuery(serverId).queryKey,
        mcpServerSchema.parse(await res.json()),
      );
    },
    onSuccess: () => serversChanged(queryClient),
  });
}

// The person connecting their own credentials for a server: their header values, checked by the
// server first; or signing in with it, the browser leaving and coming back where it was, or to the
// page given. Threads are read again for their connection.
export function useConnect() {
  const queryClient = useQueryClient();
  async function connected() {
    await queryClient.invalidateQueries({ queryKey: ["mcp-connections"] });
    await queryClient.invalidateQueries({ queryKey: ["threads"] });
  }
  const headers = useMutation({
    mutationFn: async ({
      serverId,
      values,
    }: {
      serverId: string;
      values: { name: string; value: string }[];
    }) => {
      const res = await apiClient.v1["mcp-servers"][":id"].connection.$put({
        param: { id: serverId },
        json: { headers: values },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: connected,
  });
  const oauth = useMutation({
    mutationFn: async ({ serverId, returnTo }: { serverId: string; returnTo?: string }) => {
      const res = await apiClient.v1["mcp-servers"][":id"].connection.authorize.$post({
        param: { id: serverId },
        json: { returnTo: returnTo ?? `${window.location.pathname}${window.location.search}` },
      });
      if (!res.ok) throw new Error(await errorOf(res));
      const result = mcpConnectResultSchema.parse(await res.json());
      if (result.status === "redirect") {
        window.location.assign(result.url);
        return new Promise<never>(() => {});
      }
    },
    onSuccess: connected,
  });
  return { headers, oauth };
}

export function useDisconnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (serverId: string) => {
      const res = await apiClient.v1["mcp-servers"][":id"].connection.$delete({
        param: { id: serverId },
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp-connections"] }),
  });
}

export function useRemoveServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (serverId: string) => {
      const res = await apiClient.v1["mcp-servers"][":id"].$delete({ param: { id: serverId } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => serversChanged(queryClient),
  });
}
