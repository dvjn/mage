// The org's models: the default model and reasoning effort new threads start with, side by side,
// and the model that names threads, picked from what its connections unlock, with the lists read
// again on demand and each connection whose list could not be read named.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { Effort } from "@/shared/threads.ts";
import { WithTooltip } from "@/web/components/with-tooltip";
import { EffortField, modelName, ModelField } from "@/web/models/default-fields";
import { SettingsCard } from "@/web/settings/layout";
import { Button } from "@/web/components/ui/button";
import { FieldError, FieldGroup } from "@/web/components/ui/field";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import {
  connectionsQuery,
  defaultEffortQuery,
  defaultModelQuery,
  fetchModels,
  modelsQuery,
  titleModelQuery,
} from "@/web/models/queries";
import { connectionLabel } from "@/shared/connections.ts";

export function ModelsCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const models = useQuery(modelsQuery);
  const connections = useQuery({ ...connectionsQuery, enabled: canManage });
  const defaultModel = useQuery(defaultModelQuery);
  const defaultEffort = useQuery(defaultEffortQuery);
  const titleModel = useQuery(titleModelQuery);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  async function refresh() {
    setRefreshing(true);
    try {
      queryClient.setQueryData(modelsQuery.queryKey, await fetchModels(true));
    } finally {
      setRefreshing(false);
    }
  }

  async function saved(res: Response, queryKey: readonly unknown[]) {
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setError(undefined);
    await queryClient.invalidateQueries({ queryKey });
  }

  function labelOf(connectionId: string) {
    const connection = connections.data?.find((c) => c.id === connectionId);
    return connection ? connectionLabel(connection) : "A connection";
  }

  const list = models.data?.models ?? [];
  const automatic = titleModel.data?.automatic ?? null;
  const pending = [models, defaultModel, defaultEffort, titleModel].find((q) => q.isPending);
  const failed = [models, defaultModel, defaultEffort, titleModel].find((q) => q.error);
  return (
    <SettingsCard
      title="Models"
      description={
        defaultModel.data && !defaultModel.data.ref
          ? "Pick a default model for new threads."
          : "New threads start with this model and effort; each space and thread can choose its own."
      }
      action={
        <WithTooltip label="Refresh models">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh models"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </Button>
        </WithTooltip>
      }
      state={{ isPending: !!pending, error: failed?.error ?? null }}
    >
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <ModelField
            label="Default model"
            models={list}
            value={defaultModel.data?.ref ?? null}
            onChange={(ref) => {
              if (!ref) return;
              void apiClient.v1.settings["default-model"]
                .$put({ json: { ref } })
                .then((res) => saved(res, defaultModelQuery.queryKey));
            }}
            placeholder="Pick a default"
            disabled={!canManage}
            // Gone with its provider, it gives way to the first model still on.
            fallback={list[0]?.name}
            fallbackFor="org"
          />
          <EffortField
            value={defaultEffort.data?.effort ?? null}
            onChange={(effort: Effort | null) =>
              void apiClient.v1.settings["default-effort"]
                .$put({ json: { effort } })
                .then((res) => saved(res, defaultEffortQuery.queryKey))
            }
            defaultLabel="Default · Medium"
            disabled={!canManage}
          />
        </div>
        <ModelField
          label="Title model"
          models={list}
          value={titleModel.data?.ref ?? null}
          onChange={(ref) =>
            void apiClient.v1.settings["title-model"]
              .$put({ json: { ref } })
              .then((res) => saved(res, titleModelQuery.queryKey))
          }
          inherit={{
            label: `Automatic · ${modelName(list, automatic) ?? "each thread's model"}`,
            ref: automatic,
          }}
          disabled={!canManage}
          description="Names new threads after their first message."
        />
        {models.data?.errors.map((failed) => (
          <FieldError key={failed.connectionId}>
            {labelOf(failed.connectionId)}: {failed.message}
          </FieldError>
        ))}
        <FieldError>{error}</FieldError>
      </FieldGroup>
    </SettingsCard>
  );
}
