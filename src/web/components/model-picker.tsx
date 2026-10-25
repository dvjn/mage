// The one model picker: a button opening a searchable list of the models the org can use, grouped
// by the connection they come through, each group marked with its host and each model with its
// maker, found by its name, its maker's or its host's, with the default the level above chose
// offered first where there is one, and a
// model that is turned off or gone shown as a warning with what stands in. Connections whose models
// could not be read follow, each saying so with why. With no models at all, it points to adding a
// model provider. As a form field it is outlined, full width and opens below;
// compact, it is a composer button that opens above.

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "cn";

import { connectionLabel } from "@/shared/connections.ts";
import { type HostId, hostOf } from "@/shared/hosts.ts";
import { MAKERS } from "@/shared/makers.ts";
import type { ModelSummary } from "@/shared/models.ts";
import { promptInputSelectTriggerClassName } from "@/web/components/ai-elements/prompt-input";
import { givenName, HostMark, MakerMark } from "@/web/components/marks";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/web/components/ui/combobox";
import { selectTriggerClassName } from "@/web/components/ui/select";
import { Skeleton } from "@/web/components/ui/skeleton";
import { WithTooltip } from "@/web/components/with-tooltip";
import { connectionsQuery, modelsQuery } from "@/web/lib/queries";

// A tooltip when there is something to say.
function MaybeTooltip({ label, children }: { label?: string; children: React.ReactElement }) {
  return label ? <WithTooltip label={label}>{children}</WithTooltip> : children;
}

// The sign-ins a failed run can name.
export const CONNECTION_LABELS: Record<"codex" | "claude", string> = {
  codex: "Codex",
  claude: "Claude",
};

interface Group {
  value: string;
  label: string;
  host: HostId;
  items: ModelSummary[];
}

function groupsOf(models: ModelSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const model of models) {
    const group = groups.get(model.connectionId) ?? {
      value: model.connectionId,
      label: model.connectionLabel,
      host: model.host,
      items: [],
    };
    group.items.push(model);
    groups.set(model.connectionId, group);
  }
  return [...groups.values()];
}

// Whether every word searched for is in the model's name or id, its maker's name or its
// connection's, as "bedrock claude".
function matches(model: ModelSummary, query: string) {
  const text = [
    model.name,
    model.id,
    model.maker && MAKERS[model.maker].label,
    hostOf(model.host).label,
    model.connectionLabel,
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

// The org's connections whose models could not be read, with why.
function useFailedConnections() {
  const list = useQuery(modelsQuery);
  const connections = useQuery(connectionsQuery);
  return (list.data?.errors ?? []).flatMap(({ connectionId, message }) => {
    const connection = connections.data?.find((c) => c.id === connectionId);
    if (!connection) return [];
    return [
      { id: connectionId, host: connection.host, label: connectionLabel(connection), message },
    ];
  });
}

export interface MissingModel {
  name: string;
  off: boolean;
  // What to tell people.
  message: string;
}

// The model a picker shows when it is not one that can be picked: turned off, or gone with its
// provider; null while the list loads or when it is fine.
export function useMissingModel(
  models: ModelSummary[],
  ref: string | null | undefined,
  loading?: boolean,
): MissingModel | null {
  const list = useQuery(modelsQuery);
  if (loading || !ref || models.some((model) => model.ref === ref)) return null;
  const off = list.data?.turnedOff.find((model) => model.ref === ref);
  return {
    name: off?.name ?? ref.slice(ref.indexOf("/") + 1),
    off: !!off,
    message: off ? "This model is turned off." : "This model is no longer available.",
  };
}

// Why another model stands in for one turned off or gone, for a thread or for a space's threads.
export function fallbackReason(
  missing: MissingModel,
  who: "thread" | "space" | "org",
  used?: string | null,
) {
  const what = missing.off ? "is turned off" : "is no longer available";
  const until = missing.off
    ? "until it's back on or you choose another"
    : "until you choose another";
  if (who === "org") return `${missing.name} ${what}, so threads use ${used} ${until}.`;
  return who === "thread"
    ? `${missing.name} ${what}, so this thread uses the default ${until}.`
    : `${missing.name} ${what}, so this space uses the org default ${until}.`;
}

export function ModelPicker({
  id,
  models,
  value,
  onChange,
  placeholder = "Pick a model",
  disabled,
  className,
  open,
  onOpenChange,
  variant = "field",
  inherit,
  fallback,
  loading,
}: {
  id?: string;
  models: ModelSummary[];
  value: string | null;
  onChange: (ref: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  // Opens and closes the list from outside, when given.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "field" | "compact";
  // Following the level above's model, offered first in the list, checked while followed; while
  // followed, the picker shows its label.
  // A warning on it, as when the space's own default is turned off and the org's stands in.
  inherit?: {
    label: string;
    ref: string | null;
    active: boolean;
    onSelect: () => void;
    warning?: string;
  };
  // While the model shown is turned off or gone: what is used instead, as "Default · Sonnet", and
  // why, for its tooltip.
  fallback?: { label: string; reason: string };
  // Shows a placeholder in the trigger until the models are known.
  loading?: boolean;
}) {
  const selected = models.find((model) => model.ref === value) ?? null;
  const shownRef = value ?? (inherit?.active ? inherit.ref : null);
  // The model shown, chosen or followed, when it cannot be picked.
  const missing = useMissingModel(models, shownRef, loading);
  const shown = models.find((model) => model.ref === shownRef);
  const label = missing
    ? (fallback?.label ?? missing.name)
    : selected
      ? selected.name
      : inherit?.active
        ? inherit.label
        : placeholder;
  const groups = groupsOf(models);
  const failed = useFailedConnections();
  const compact = variant === "compact";
  return (
    <Combobox
      items={groups}
      value={selected}
      onValueChange={(model) => {
        if (model) onChange(model.ref);
      }}
      itemToStringLabel={(model: ModelSummary) => model.name}
      filter={(model: ModelSummary, query: string) => matches(model, query)}
      isItemEqualToValue={(a: ModelSummary, b: ModelSummary) => a.ref === b.ref}
      disabled={disabled || loading}
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange: (next: boolean) => onOpenChange(next) })}
    >
      <MaybeTooltip label={missing ? (fallback?.reason ?? missing.message) : undefined}>
        <ComboboxTrigger
          id={id}
          // A field is named by its label.
          {...(compact && { "aria-label": "Model" })}
          data-size={compact ? "sm" : "default"}
          className={cn(
            selectTriggerClassName,
            compact ? [promptInputSelectTriggerClassName, "max-w-56"] : "w-full",
            className,
            // A model turned off or gone is a warning: something stands in, or it needs choosing.
            missing &&
              "text-amber-700 data-placeholder:text-amber-700 hover:text-amber-700 dark:text-amber-400 dark:data-placeholder:text-amber-400",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {loading ? (
              <Skeleton className="h-3.5 w-24" />
            ) : (
              <>
                {missing ? (
                  <TriangleAlertIcon className="size-3.5 shrink-0" />
                ) : (
                  shown && <MakerMark maker={shown.maker} className="size-3.5" />
                )}
                <span
                  className={cn(
                    "truncate",
                    !selected && !missing && !inherit?.active && "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              </>
            )}
          </span>
        </ComboboxTrigger>
      </MaybeTooltip>
      <ComboboxContent
        {...(compact
          ? { side: "top" as const, className: "w-auto min-w-64" }
          : { className: "w-auto min-w-(--anchor-width)" })}
      >
        <ComboboxInput showTrigger={false} placeholder="Search models" aria-label="Search models" />
        {missing && (
          <div
            aria-disabled
            className="flex items-center gap-2 border-b px-3 py-2 text-sm text-muted-foreground"
          >
            <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />
            <span className="truncate">{missing.name}</span>
            <span className="ml-auto text-xs">{missing.off ? "Turned off" : "Unavailable"}</span>
          </div>
        )}
        {inherit && (
          <div className="border-b p-1">
            <button
              type="button"
              aria-pressed={inherit.active}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onOpenChange?.(false);
                inherit.onSelect();
              }}
            >
              {inherit.warning && (
                <MaybeTooltip label={inherit.warning}>
                  <TriangleAlertIcon
                    aria-label={inherit.warning}
                    className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                  />
                </MaybeTooltip>
              )}
              <span className="whitespace-nowrap">{inherit.label}</span>
              {inherit.active && <CheckIcon className="ml-auto size-4" />}
            </button>
          </div>
        )}
        <ComboboxEmpty>
          {models.length === 0 ? (
            <Link to="/org/providers" className="underline underline-offset-4">
              Add a model provider
            </Link>
          ) : (
            "No models found."
          )}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: Group, index: number) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel className="flex items-center gap-1.5">
                <HostMark host={group.host} label={givenName(group.label)} className="size-3" />
                {group.label}
              </ComboboxLabel>
              <ComboboxCollection>
                {(model: ModelSummary) => (
                  <ComboboxItem key={model.ref} value={model}>
                    <MakerMark maker={model.maker} className="size-3.5" />
                    {model.name}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
              {index < groups.length - 1 && <ComboboxSeparator />}
            </ComboboxGroup>
          )}
        </ComboboxList>
        {failed.length > 0 && (
          <ul aria-label="Not loaded" className="border-t p-1">
            {failed.map(({ id, host, label, message }) => (
              <li key={id}>
                <WithTooltip label={message}>
                  <span
                    tabIndex={0}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground"
                  >
                    <HostMark host={host} label={givenName(label)} className="size-3" />
                    <span className="truncate">{label}</span>
                    <span className="ml-auto pl-3 whitespace-nowrap">
                      Couldn&apos;t load<span className="sr-only">: {message}</span>
                    </span>
                  </span>
                </WithTooltip>
              </li>
            ))}
          </ul>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
