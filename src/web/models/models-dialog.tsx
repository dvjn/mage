// A provider's models in a dialog: whether models it adds later are turned on by themselves, and
// each model with a switch for whether people can pick it, marked when it thinks and with how
// much it reads, narrowed by a filter, with one switch for all of those shown. Changes save as
// they are made; the organization's default model stays on, marked as such, and spaces that start
// threads on a model turned off are named. A list that could not be read says why, to try again.

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { RotateCcwIcon } from "lucide-react";
import { useId, useState } from "react";

import { type ConnectionSummary, connectionLabel } from "@/shared/connections.ts";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { FieldError } from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Switch } from "@/web/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { useConnectionModels } from "@/web/models/mutations";
import { connectionModelsQuery } from "@/web/models/queries";

// "128K", "1M": how many tokens a model reads.
function contextSize(tokens: number) {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : `${Math.round(tokens / 1000)}K`;
}

export function ModelsDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: ConnectionSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const query = connectionModelsQuery(connection?.id ?? "");
  const list = useQuery({ ...query, enabled: open && !!connection });
  const [filter, setFilter] = useState("");
  const [warning, setWarning] = useState<string>();
  const switching = useConnectionModels(connection?.id ?? "");

  function change(json: { autoEnable?: boolean; set?: { ids: string[]; enabled: boolean } }) {
    if (!connection) return;
    setWarning(undefined);
    switching.mutate(json, {
      onSuccess: (updated) => {
        const spaces = updated.spacesUsingOff ?? [];
        if (spaces.length > 0) {
          setWarning(
            `${spaces.map((s) => s.name).join(", ")} ${spaces.length === 1 ? "starts" : "start"} new threads on a model now turned off. Choose another in ${spaces.length === 1 ? "its" : "their"} space settings.`,
          );
        }
      },
    });
  }

  const needle = filter.trim().toLowerCase();
  const all = list.data?.models ?? [];
  const models = all.filter(
    (m) => m.name.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle),
  );
  // Available among those shown; the one switch for them is on when every one that can be turned
  // off is on.
  const on = models.filter((m) => m.enabled).length;
  const switchable = models.filter((m) => !m.orgDefault);
  const allOn = switchable.length > 0 && switchable.every((m) => m.enabled);
  const name = connection ? connectionLabel(connection) : "";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFilter("");
          switching.reset();
          setWarning(undefined);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{name} models</DialogTitle>
          <DialogDescription>
            Choose which of this provider&apos;s models people can pick. Threads using a model you
            turn off use the default until it&apos;s back on.
          </DialogDescription>
        </DialogHeader>
        {list.error ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-destructive">
              {list.error.message}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              <RotateCcwIcon />
              Try again
            </Button>
          </div>
        ) : !list.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <label htmlFor={`${id}-auto`} className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Turn on new models automatically</span>
                <span className="text-sm text-muted-foreground">
                  When the provider adds a model, it shows up in pickers right away. When off, new
                  models wait here until you turn them on.
                </span>
              </label>
              <Switch
                id={`${id}-auto`}
                checked={list.data.autoEnable}
                onCheckedChange={(checked) => change({ autoEnable: checked })}
              />
            </div>
            <Input
              type="search"
              aria-label="Filter models"
              placeholder="Filter models"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <FieldError>{switching.error?.message}</FieldError>
            {warning && (
              <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                {warning}
              </p>
            )}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
              <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <span className="flex-1">
                  {needle
                    ? `${models.length} of ${all.length} shown · ${on} available`
                    : `${all.length} ${all.length === 1 ? "model" : "models"} · ${on} available`}
                </span>
                <Switch
                  aria-label={needle ? "All shown models available" : "All models available"}
                  checked={allOn}
                  disabled={switchable.length === 0}
                  onCheckedChange={(checked) =>
                    change({ set: { ids: models.map((m) => m.id), enabled: checked } })
                  }
                />
              </div>
              <ul aria-label="Models" className="min-h-0 flex-1 divide-y overflow-y-auto">
                {models.map((model) => (
                  <li key={model.id} aria-label={model.name}>
                    <label
                      className={cn(
                        "flex items-center gap-3 px-3 py-2",
                        !model.orgDefault && "cursor-pointer hover:bg-muted/40",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium">{model.name}</span>
                          {model.orgDefault && <Badge variant="secondary">Default</Badge>}
                          {model.reasoning && <Badge variant="outline">Thinks</Badge>}
                          {model.contextWindow && (
                            <Badge variant="outline">{contextSize(model.contextWindow)}</Badge>
                          )}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {model.id}
                        </span>
                      </span>
                      {model.orgDefault ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span>
                                <Switch aria-label={`${model.name} available`} checked disabled />
                              </span>
                            }
                          />
                          <TooltipContent>
                            Stays on because it&apos;s the organization&apos;s default.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <Switch
                          aria-label={`${model.name} available`}
                          checked={model.enabled}
                          onCheckedChange={(checked) =>
                            change({ set: { ids: [model.id], enabled: checked } })
                          }
                        />
                      )}
                    </label>
                  </li>
                ))}
                {models.length === 0 && (
                  <li className="p-4 text-sm text-muted-foreground">
                    {needle ? "No model matches." : "This provider lists no models."}
                  </li>
                )}
              </ul>
            </div>
          </>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
