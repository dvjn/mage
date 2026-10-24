// The organization's model providers: a card with a table of its connections (provider and label,
// how it connects, the account or masked key, how many of its models are on, when it was added),
// each with a menu to choose its models, rename an API key, set its proxy or remove it, and adding
// one through the add-provider journey. On a phone each row is two lines. The org's owners manage
// them; its members see them. A team org connects with API keys only.

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
import { EmptyState } from "@/web/components/page-states";
import { HeaderAction } from "@/web/components/people-table";
import { Time } from "@/web/components/time";
import { WithTooltip } from "@/web/components/with-tooltip";
import { NameDialog } from "@/web/components/name-dialog";
import { AddProviderDialog } from "@/web/components/settings/add-provider";
import { SettingsCard, SettingsTitle } from "@/web/components/settings/layout";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
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
          Models
        </DropdownMenuItem>
        {key && (
          <DropdownMenuItem onClick={() => onAction({ kind: "rename", connection })}>
            <PencilIcon />
            Rename label
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onAction({ kind: "proxy", connection })}>
          <ServerCogIcon />
          Proxy settings
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
  manages,
  onAction,
}: {
  connections: ConnectionSummary[];
  manages: boolean;
  onAction: (action: RowAction) => void;
}) {
  return (
    <Table aria-label="Model providers">
      <TableHeader className="hidden sm:table-header-group">
        <TableRow className="hover:bg-transparent">
          <TableHead className="px-3 text-xs text-muted-foreground">Provider</TableHead>
          <TableHead className="px-3 text-xs text-muted-foreground">Method</TableHead>
          <TableHead className="px-3 text-xs text-muted-foreground">Account</TableHead>
          <TableHead className="px-3 text-xs text-muted-foreground">Models</TableHead>
          <TableHead className="px-3 text-xs text-muted-foreground">Added</TableHead>
          <TableHead className="w-10 px-1">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.map((connection) => {
          const name = connectionLabel(connection);
          return (
            <TableRow key={connection.id} aria-label={name} className="group">
              <TableCell className="w-full max-w-0 px-3 py-2.5">
                <div className="truncate font-medium">{name}</div>
                {/* On a phone the other columns fold into this line. */}
                <div className="truncate text-xs text-muted-foreground sm:hidden">
                  {METHODS[connection.authKind]} ·{" "}
                  <span className={connection.authKind === "api_key" ? "font-mono" : undefined}>
                    {connection.account}
                  </span>
                </div>
              </TableCell>
              <TableCell className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
                {METHODS[connection.authKind]}
              </TableCell>
              <TableCell className="hidden max-w-48 truncate px-3 py-2.5 sm:table-cell">
                <span className={connection.authKind === "api_key" ? "font-mono" : undefined}>
                  {connection.account}
                </span>
              </TableCell>
              <TableCell className="hidden px-3 py-2.5 sm:table-cell">
                {manages ? (
                  <ModelsCount
                    connection={connection}
                    onOpen={() => onAction({ kind: "models", connection })}
                  />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="hidden px-3 py-2.5 text-muted-foreground sm:table-cell">
                <Time iso={connection.createdAt} />
              </TableCell>
              <TableCell className="w-10 px-1 py-2 text-right">
                {manages && <RowMenu connection={connection} onAction={onAction} />}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
              Threads on its models fall back to the default model.
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
  const manages = me.data?.role === "owner";
  const team = me.data?.org.kind === "team";
  const connections = useQuery({ ...connectionsQuery, enabled: !!me.data });
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<RowAction | null>(null);
  const list = connections.data ?? [];

  return (
    <>
      <SettingsTitle
        title="Model providers"
        description="The accounts and keys this organization's threads are answered through."
      />
      <SettingsCard
        description={
          me.data && !manages && "Only the organization's owners manage its model providers."
        }
        action={
          manages && (
            <HeaderAction
              icon={<PlusIcon />}
              label="Add provider"
              onClick={() => setAdding(true)}
            />
          )
        }
        state={connections}
      >
        {list.length === 0 ? (
          <EmptyState
            icon={<BlocksIcon />}
            title="No model providers yet"
            description={
              manages
                ? "Add one to give this organization's threads models to reply with."
                : "An owner of the organization adds them."
            }
          />
        ) : (
          <ProvidersTable connections={list} manages={manages} onAction={setAction} />
        )}
      </SettingsCard>
      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        connections={list}
        apiKeysOnly={team}
      />
      <RowDialogs action={action} onClose={() => setAction(null)} />
    </>
  );
}
