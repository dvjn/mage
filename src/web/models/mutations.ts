// Changes to the org's models and provider connections: the default model, effort and title model,
// reading the models again, adding, changing and removing a connection, its proxy and which of its
// models are on, and starting or cancelling a ChatGPT sign-in.

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { connectionSchema, deviceStartSchema } from "@/shared/connections.ts";
import { connectionModelsSchema } from "@/shared/models.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import {
  connectionModelsQuery,
  connectionsQuery,
  defaultEffortQuery,
  defaultModelQuery,
  fetchModels,
  modelsQuery,
  titleModelQuery,
} from "@/web/models/queries";

type ModelSetting =
  | { setting: "default-model"; ref: string }
  | { setting: "default-effort"; effort: Effort | null }
  | { setting: "title-model"; ref: string | null };

const SETTING_QUERIES = {
  "default-model": defaultModelQuery.queryKey,
  "default-effort": defaultEffortQuery.queryKey,
  "title-model": titleModelQuery.queryKey,
};

export function useModelSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (change: ModelSetting) => {
      const settings = apiClient.v1.settings;
      const res =
        change.setting === "default-model"
          ? await settings["default-model"].$put({ json: { ref: change.ref } })
          : change.setting === "default-effort"
            ? await settings["default-effort"].$put({ json: { effort: change.effort } })
            : await settings["title-model"].$put({ json: { ref: change.ref } });
      if (!res.ok) throw new Error(await errorOf(res));
      return change.setting;
    },
    onSuccess: (setting) => queryClient.invalidateQueries({ queryKey: SETTING_QUERIES[setting] }),
  });
}

// Asks every connection for its models again.
export function useRefreshModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchModels(true),
    onSuccess: (models) => queryClient.setQueryData(modelsQuery.queryKey, models),
  });
}

async function connectionsChanged(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
  await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
}

export function useRemoveConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const res = await apiClient.v1.connections[":id"].$delete({ param: { id: connectionId } });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: () => connectionsChanged(queryClient),
  });
}

export function useSaveProxy(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: {
      baseUrl: string | null;
      headers: Record<string, string | null>;
    }) => {
      const res = await apiClient.v1.connections[":id"].proxy.$patch({
        param: { id: connectionId },
        json,
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return json;
    },
    onSuccess: () => connectionsChanged(queryClient),
  });
}

type NewConnection = Parameters<typeof apiClient.v1.connections.$post>[0]["json"];
type ConnectionChange = Parameters<(typeof apiClient.v1.connections)[":id"]["$patch"]>[0]["json"];

// Adds a connection, answering it once its models are read.
export function useAddConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: NewConnection) => {
      const res = await apiClient.v1.connections.$post({ json });
      if (!res.ok) throw new Error(await errorOf(res));
      return connectionSchema.parse(await res.json());
    },
    onSuccess: () => connectionsChanged(queryClient),
  });
}

export function useEditConnection(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: ConnectionChange) => {
      const res = await apiClient.v1.connections[":id"].$patch({
        param: { id: connectionId },
        json,
      });
      if (!res.ok) throw new Error(await errorOf(res));
    },
    onSuccess: async () => {
      await connectionsChanged(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["connection-models", connectionId] });
    },
  });
}

// Turns a connection's models on or off, or whether new ones arrive on; answers which spaces
// start threads on a model now off.
export function useConnectionModels(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: {
      autoEnable?: boolean;
      set?: { ids: string[]; enabled: boolean };
    }) => {
      const res = await apiClient.v1.connections[":id"].models.$patch({
        param: { id: connectionId },
        json,
      });
      if (!res.ok) throw new Error(await errorOf(res));
      return connectionModelsSchema.parse(await res.json());
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(connectionModelsQuery(connectionId).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
    },
  });
}

// Starts a ChatGPT sign-in, answering the code to enter and where.
export function useStartCodexSignIn() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.v1.connections.codex.device.$post();
      if (!res.ok) throw new Error(await errorOf(res));
      return deviceStartSchema.parse(await res.json());
    },
  });
}

// Gives up on a sign-in still waiting for its code; a failure leaves nothing to tell.
export function useCancelCodexSignIn() {
  return useMutation({
    mutationFn: async (attemptId: string) => {
      await apiClient.v1.connections.codex.attempts[":id"].cancel.$post({
        param: { id: attemptId },
      });
    },
  });
}
