// The organization's model providers: a table of its connections (provider and label, how it
// connects, the account or masked key, how many of its models are on, when it was added), each
// with a menu to choose its models, rename an API key, set its proxy or remove it, and adding one
// through the add-provider journey. On a phone each row is two lines. Only the owner of a personal
// org manages them.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BlocksIcon,
  ListChecksIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { type ConnectionSummary, connectionLabel } from "@/shared/connections.ts";
import { EmptyState, ListSkeleton, LoadError } from "@/web/components/page-states";
import { Time } from "@/web/components/time";
import { WithTooltip } from "@/web/components/with-tooltip";
import { NameDialog } from "@/web/components/name-dialog";
import { AddProviderDialog } from "@/web/components/settings/add-provider";
import { SettingsTitle } from "@/web/components/settings/layout";
import { connectionModelsQuery, ModelsDialog } from "@/web/components/settings/models-dialog";
import { ProxyForm } from "@/web/components/settings/proxy-settings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/web/components/ui/alert-dialog";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { connectionsQuery, meQuery, modelsQuery } from "@/web/lib/queries";

const METHODS: Record<ConnectionSummary["authKind"], string> = {
  api_key: "API key",
  codex: "ChatGPT sign-in",
  claude: "Claude sign-in",
};

type RowAction = {
  kind: "models" | "rename" | "proxy" | "remove";
  connection: ConnectionSummary;
};

function RowMenu({
  connection,
  onAction,
}: {
  connection: ConnectionSummary;
  onAction: (action: RowAction) => void;
}) {
  const key = connection.authKind === "api_key";
  return (
    <DropdownMenu>
      <WithTooltip label="Actions">
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Actions for ${connectionLabel(connection)}`}
              className="group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-fine:opacity-0"
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={() => onAction({ kind: "models", connection })}>
          <ListChecksIcon />
          Models…
        </DropdownMenuItem>
        {key && (
          <DropdownMenuItem onClick={() => onAction({ kind: "rename", connection })}>
            <PencilIcon />
            Rename label…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onAction({ kind: "proxy", connection })}>
          <ServerCogIcon />
          Proxy settings…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onAction({ kind: "remove", connection })}
        >
          <Trash2Icon />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "12 of 15 on", opening the provider's models.
function ModelsCount({
  connection,
  onOpen,
}: {
  connection: ConnectionSummary;
  onOpen: () => void;
}) {
  const list = useQuery(connectionModelsQuery(connection.id));
  const on = list.data?.models.filter((m) => m.enabled).length ?? 0;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="-ml-2 font-normal"
      aria-label={`Models of ${connectionLabel(connection)}`}
      onClick={onOpen}
    >
      {list.data ? `${on} of ${list.data.models.length} on` : list.error ? "Unavailable" : "…"}
    </Button>
  );
}

function ProvidersTable({
  connections,
  onAction,
}: {
  connections: ConnectionSummary[];
  onAction: (action: RowAction) => void;
}) {
  return (
    <div>
      <table className="w-full text-sm" aria-label="Model providers">
        <thead className="hidden border-b text-left text-xs text-muted-foreground sm:table-header-group">
          <tr>
            <th className="px-3 py-2 font-medium">Provider</th>
            <th className="px-3 py-2 font-medium">Method</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Models</th>
            <th className="px-3 py-2 font-medium">Added</th>
            <th className="w-10 px-1 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y [&_tr_td:first-child]:rounded-l-md [&_tr_td:last-child]:rounded-r-md">
          {connections.map((connection) => {
            const name = connectionLabel(connection);
            return (
              <tr
                key={connection.id}
                aria-label={name}
                className="group align-middle hover:bg-muted/50"
              >
                <td className="px-3 py-2.5">
                  <div className="font-medium">{name}</div>
                  {/* On a phone the other columns fold into this line. */}
                  <div className="truncate text-xs text-muted-foreground sm:hidden">
                    {METHODS[connection.authKind]} ·{" "}
                    <span className={connection.authKind === "api_key" ? "font-mono" : undefined}>
                      {connection.account}
                    </span>
                  </div>
                </td>
                <td className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
                  {METHODS[connection.authKind]}
                </td>
                <td className="hidden max-w-48 truncate px-3 py-2.5 sm:table-cell">
                  <span className={connection.authKind === "api_key" ? "font-mono" : undefined}>
                    {connection.account}
                  </span>
                </td>
                <td className="hidden px-3 py-2.5 sm:table-cell">
                  <ModelsCount
                    connection={connection}
                    onOpen={() => onAction({ kind: "models", connection })}
                  />
                </td>
                <td className="hidden px-3 py-2.5 whitespace-nowrap text-muted-foreground sm:table-cell">
                  <Time iso={connection.createdAt} />
                </td>
                <td className="px-1 py-2 text-right">
                  <RowMenu connection={connection} onAction={onAction} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowDialogs({ action, onClose }: { action: RowAction | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const connections = useQuery(connectionsQuery);
  // As it is now, after the dialog's own changes.
  const connection =
    connections.data?.find((c) => c.id === action?.connection.id) ?? action?.connection;
  const name = connection ? connectionLabel(connection) : "";

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
  }

  async function rename(label: string) {
    if (!connection) return undefined;
    const res = await apiClient.v1.connections[":id"].label.$patch({
      param: { id: connection.id },
      json: { label },
    });
    if (!res.ok) return errorOf(res);
    await refresh();
    return undefined;
  }

  async function remove() {
    if (!connection) return;
    const res = await apiClient.v1.connections[":id"].$delete({ param: { id: connection.id } });
    if (!res.ok) {
      const failed = await errorOf(res);
      setError(failed);
      return;
    }
    await refresh();
    close(false);
  }

  function close(open: boolean) {
    if (open) return;
    setError(undefined);
    onClose();
  }

  return (
    <>
      <ModelsDialog connection={connection} open={action?.kind === "models"} onOpenChange={close} />
      <NameDialog
        key={connection?.id ?? "rename"}
        title="Rename label"
        action="Save"
        maxLength={80}
        label="Label"
        required={false}
        initialName={connection?.label ?? ""}
        open={action?.kind === "rename"}
        onOpenChange={close}
        onSubmit={rename}
      />
      <Dialog open={action?.kind === "proxy"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Proxy for {name}</DialogTitle>
            <DialogDescription>
              Send this connection&apos;s model lists and replies through another address, with
              headers of your own. Header values are never shown again.
            </DialogDescription>
          </DialogHeader>
          {connection && action?.kind === "proxy" && (
            <ProxyForm key={connection.id} connection={connection} />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={action?.kind === "remove"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Threads on its models stop getting replies until they pick another model.
              {connection?.authKind === "api_key" &&
                " The key is deleted from Mage; it still works at the provider."}
            </AlertDialogDescription>
            <FieldError>{error}</FieldError>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function OrgProviders() {
  const me = useQuery(meQuery);
  const manages = me.data?.org.kind === "personal" && me.data.role === "owner";
  const connections = useQuery({ ...connectionsQuery, enabled: manages });
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<RowAction | null>(null);
  const list = connections.data ?? [];

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon />
      Add provider
    </Button>
  );

  return (
    <>
      <SettingsTitle
        title="Model providers"
        description="The accounts and keys this organization's threads are answered through."
        action={manages && list.length > 0 && addButton}
      />
      {me.data && !manages ? (
        <p className="text-sm text-muted-foreground">
          Only the owner of a personal organization manages its model providers.
        </p>
      ) : connections.error ? (
        <LoadError />
      ) : !connections.data ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<BlocksIcon />}
          title="No model providers yet"
          description="Add an API key, or sign in with a ChatGPT or Claude subscription, to give this organization's threads models to reply with."
          action={addButton}
        />
      ) : (
        <ProvidersTable connections={list} onAction={setAction} />
      )}
      <AddProviderDialog open={adding} onOpenChange={setAdding} connections={list} />
      <RowDialogs action={action} onClose={() => setAction(null)} />
    </>
  );
}
