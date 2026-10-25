// The organization's model providers: a card with a table of its connections (the host's mark and
// label over how it connects, the account, masked key or server with its region, the makers of its
// models, how many of its models are on or why they could not be read, when it was added), each
// with a menu to choose its models, edit it, set its proxy or remove it, and adding one through
// the add-provider journey, started from the empty state while there are none. On a phone the
// account joins how it connects. The org's owners manage them; its members see them. A team org
// connects with no subscription sign-ins.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BlocksIcon,
  ListChecksIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { type ConnectionSummary, connectionLabel } from "@/shared/connections.ts";
import { methodOf } from "@/shared/hosts.ts";
import { MAKERS, type MakerId } from "@/shared/makers.ts";
import { HostMark, MakerMark } from "@/web/components/marks";
import { EmptyState } from "@/web/components/page-states";
import { HeaderAction } from "@/web/components/people-table";
import { Time } from "@/web/components/time";
import { WithTooltip } from "@/web/components/with-tooltip";
import { AddProviderDialog, EditProviderDialog } from "@/web/components/settings/add-provider";
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

// How it connects, as its host's way of connecting is called.
function methodTitle(connection: ConnectionSummary) {
  const method = methodOf(connection.host, connection.settings.method, connection.authKind);
  return method?.title ?? connection.authKind;
}

// The account, key or server, with where it runs when that was given.
function accountLine(connection: ConnectionSummary) {
  const { region, location } = connection.settings;
  return [connection.account, region ?? location].filter(Boolean).join(" · ");
}

// The marks of up to four makers of the connection's models, most models first.
function Makers({ connection }: { connection: ConnectionSummary }) {
  const models = useQuery(modelsQuery);
  const counts = new Map<MakerId, number>();
  for (const model of models.data?.models ?? []) {
    if (model.connectionId !== connection.id || !model.maker) continue;
    counts.set(model.maker, (counts.get(model.maker) ?? 0) + 1);
  }
  const makers = [...counts.entries()].toSorted((a, b) => b[1] - a[1]).map(([maker]) => maker);
  if (makers.length === 0) return <span className="text-muted-foreground">—</span>;
  const named = makers.map((maker) => MAKERS[maker].label).join(", ");
  return (
    <WithTooltip label={named}>
      <span role="img" aria-label={`Makers: ${named}`} className="flex items-center gap-1">
        {makers.slice(0, 4).map((maker) => (
          <MakerMark key={maker} maker={maker} className="size-3.5" />
        ))}
        {makers.length > 4 && (
          <span className="text-xs text-muted-foreground">+{makers.length - 4}</span>
        )}
      </span>
    </WithTooltip>
  );
}

type RowAction = {
  kind: "models" | "edit" | "proxy" | "remove";
  connection: ConnectionSummary;
};

function RowMenu({
  connection,
  onAction,
}: {
  connection: ConnectionSummary;
  onAction: (action: RowAction) => void;
}) {
  const named = connection.authKind !== "oauth";
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
        {named && (
          <DropdownMenuItem onClick={() => onAction({ kind: "edit", connection })}>
            <PencilIcon />
            Edit
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

// "12 of 15 on", opening the provider's models; when its list could not be read, saying so with
// why, and reading it again on asking.
function ModelsCount({
  connection,
  onOpen,
}: {
  connection: ConnectionSummary;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const list = useQuery(connectionModelsQuery(connection.id));
  const name = connectionLabel(connection);
  if (list.error && !list.isFetching) {
    return (
      <span className="flex items-center gap-1 whitespace-nowrap">
        <WithTooltip label={list.error.message}>
          <span tabIndex={0} className="text-xs text-muted-foreground">
            Couldn&apos;t load
            <span className="sr-only">: {list.error.message}</span>
          </span>
        </WithTooltip>
        <WithTooltip label="Try again">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Read the models of ${name} again`}
            onClick={() => {
              void list.refetch();
              void queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
            }}
          >
            <RotateCcwIcon />
          </Button>
        </WithTooltip>
      </span>
    );
  }
  const on = list.data?.models.filter((m) => m.enabled).length ?? 0;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="-ml-2 font-normal"
      aria-label={`Models of ${name}`}
      onClick={onOpen}
    >
      {list.data ? `${on} of ${list.data.models.length} on` : "…"}
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
          <TableHead className="px-3 text-xs text-muted-foreground">Account</TableHead>
          <TableHead className="px-3 text-xs text-muted-foreground">Makers</TableHead>
          <TableHead className="px-3 text-xs text-muted-foreground">Models</TableHead>
          <TableHead className="hidden px-3 text-xs text-muted-foreground 2xl:table-cell">
            Added
          </TableHead>
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
              <TableCell className="w-full max-w-0 min-w-36 px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2 font-medium">
                  <HostMark host={connection.host} label={connection.label} className="mt-0.5" />
                  <span className="line-clamp-2 break-words whitespace-normal">{name}</span>
                </div>
                {/* Under the name; on a phone the account joins it. */}
                <div className="truncate pl-6 text-xs text-muted-foreground">
                  {methodTitle(connection)}
                  <span className="sm:hidden">
                    {" · "}
                    <span className={connection.authKind === "api_key" ? "font-mono" : undefined}>
                      {accountLine(connection)}
                    </span>
                  </span>
                </div>
              </TableCell>
              <TableCell className="hidden max-w-40 truncate px-3 py-2.5 sm:table-cell">
                <span className={connection.authKind === "api_key" ? "font-mono" : undefined}>
                  {accountLine(connection)}
                </span>
              </TableCell>
              <TableCell className="hidden px-3 py-2.5 sm:table-cell">
                <Makers connection={connection} />
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
              <TableCell className="hidden px-3 py-2.5 whitespace-nowrap text-muted-foreground 2xl:table-cell">
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
      <EditProviderDialog
        connection={connection}
        open={action?.kind === "edit"}
        onOpenChange={close}
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
            action={
              manages && (
                <Button onClick={() => setAdding(true)}>
                  <PlusIcon />
                  Add provider
                </Button>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {/* Where a table's search row would hold its action. */}
            {manages && (
              <div className="flex justify-end">
                <HeaderAction
                  icon={<PlusIcon />}
                  label="Add provider"
                  onClick={() => setAdding(true)}
                />
              </div>
            )}
            <ProvidersTable connections={list} manages={manages} onAction={setAction} />
          </div>
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
