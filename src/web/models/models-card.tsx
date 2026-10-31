// The org's models: the default model and reasoning effort new threads start with, side by side,
// and the model that names threads, picked from what its connections unlock, with the lists read
// again on demand and each connection whose list could not be read named.

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { connectionLabel } from "@/shared/connections.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { Button } from "@/web/components/ui/button";
import { FieldError, FieldGroup } from "@/web/components/ui/field";
import { WithTooltip } from "@/web/components/with-tooltip";
import { EffortField, modelName, ModelField } from "@/web/models/default-fields";
import { useModelSetting, useRefreshModels } from "@/web/models/mutations";
import {
  connectionsQuery,
  defaultEffortQuery,
  defaultModelQuery,
  modelsQuery,
  titleModelQuery,
} from "@/web/models/queries";
import { SettingsCard } from "@/web/shell/settings-page";

export function ModelsCard({ canManage }: { canManage: boolean }) {
  const models = useQuery(modelsQuery);
  const connections = useQuery({ ...connectionsQuery, enabled: canManage });
  const defaultModel = useQuery(defaultModelQuery);
  const defaultEffort = useQuery(defaultEffortQuery);
  const titleModel = useQuery(titleModelQuery);
  const refresh = useRefreshModels();
  const setting = useModelSetting();

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
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
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
              setting.mutate({ setting: "default-model", ref });
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
              setting.mutate({ setting: "default-effort", effort })
            }
            defaultLabel="Default · Medium"
            disabled={!canManage}
          />
        </div>
        <ModelField
          label="Title model"
          models={list}
          value={titleModel.data?.ref ?? null}
          onChange={(ref) => setting.mutate({ setting: "title-model", ref })}
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
        <FieldError>{setting.error?.message ?? refresh.error?.message}</FieldError>
      </FieldGroup>
    </SettingsCard>
  );
}
