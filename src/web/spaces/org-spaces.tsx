// A team org's spaces, for its owners: who may make spaces and whether members get a private one,
// then every space in the org. Shared spaces open their settings, where owners change their
// members and defaults, and are deleted while they have no threads; members' private spaces are
// listed with their person, and stay theirs. Reading a space's threads still takes a role in it.

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { LayoutGridIcon, LockIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import * as z from "zod";

import type { TeamSettings } from "@/shared/orgs.ts";
import type { OrgSpace } from "@/shared/spaces.ts";
import { DataTable } from "@/web/components/data-table/data-table";
import { DataTableToolbar } from "@/web/components/data-table/data-table-toolbar";
import { EmptyState } from "@/web/components/page-states";
import {
  actionsColumn,
  ActionsMenu,
  contextColumn,
  filterColumn,
  nameColumn,
  Subject,
} from "@/web/shell/people-table";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { Time } from "@/web/components/time";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Switch } from "@/web/components/ui/switch";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useDataTable } from "@/web/hooks/use-data-table";
import { lenient, tableSearchSchema, withoutUnset } from "@/web/lib/data-table";
import { orgSpacesPage } from "@/web/api/list-queries";
import { meQuery } from "@/web/auth/queries";
import { teamSettingsQuery } from "@/web/orgs/queries";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { useDeleteSpace, useTeamSettings } from "@/web/spaces/mutations";

const orgSpacesRoute = getRouteApi("/_app/org/spaces");

const KIND_FILTER = [
  { value: "shared", label: "Shared" },
  { value: "personal", label: "Private" },
];

const EVERYONE_FILTER = [
  { value: "none", label: "None" },
  { value: "viewer", label: "Viewer" },
  { value: "messager", label: "Messager" },
];

const CREATION_LABELS: Record<TeamSettings["spaceCreation"], string> = {
  members: "Every member",
  owners: "Owners only",
};

const EVERYONE_LABELS = { messager: "Messager", viewer: "Viewer" } as const;

function SpaceSettingsCard() {
  const creationId = useId();
  const switchId = useId();
  const settings = useQuery(teamSettingsQuery);
  const settingsChange = useTeamSettings();

  return (
    <SettingsCard title="Settings" state={settings}>
      {settings.data && (
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={creationId}>Who can create spaces</FieldLabel>
              <FieldDescription>Members who can start new shared spaces.</FieldDescription>
            </FieldContent>
            <Select
              value={settings.data.spaceCreation}
              onValueChange={(next) =>
                next &&
                settingsChange.mutate({ spaceCreation: next as TeamSettings["spaceCreation"] })
              }
            >
              <SelectTrigger id={creationId} className="w-36 shrink-0">
                <SelectValue>
                  {(value: TeamSettings["spaceCreation"]) => CREATION_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {(Object.keys(CREATION_LABELS) as TeamSettings["spaceCreation"][]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {CREATION_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={switchId}>Private member spaces</FieldLabel>
              <FieldDescription>
                Each member gets a space of their own on joining, which only they can see. Turning
                this off keeps the ones already made.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={switchId}
              checked={settings.data.memberSpaces}
              onCheckedChange={(memberSpaces) => settingsChange.mutate({ memberSpaces })}
            />
          </Field>
          <FieldError>{settingsChange.error?.message}</FieldError>
        </FieldGroup>
      )}
    </SettingsCard>
  );
}

// Each space's name and what it is, its members and what everyone gets when it is shared, when it
// was made, and its menu. Its kind only narrows them.
function spacesColumns(onSettings: (space: OrgSpace) => void, onDelete: (space: OrgSpace) => void) {
  const everyoneOf = (space: OrgSpace) =>
    space.kind === "shared"
      ? space.everyoneRole
        ? EVERYONE_LABELS[space.everyoneRole]
        : "None"
      : "—";
  const membersOf = (space: OrgSpace) =>
    `${space.memberCount} ${space.memberCount === 1 ? "member" : "members"}`;
  return [
    nameColumn<OrgSpace>("Space", (space) => (
      <Subject
        avatar={{ initials: space.name }}
        name={space.name}
        detail={
          space.kind === "shared" ? (
            `Shared${space.ownerName ? ` · made by ${space.ownerName}` : ""}`
          ) : (
            <span className="inline-flex items-center gap-1">
              <LockIcon className="size-3" />
              {space.ownerName && space.name !== `${space.ownerName}'s Space`
                ? `Private · ${space.ownerName}`
                : "Private"}
            </span>
          )
        }
        folded={
          space.kind === "shared"
            ? `${membersOf(space)} · Everyone: ${everyoneOf(space)}`
            : undefined
        }
      />
    )),
    contextColumn<OrgSpace>(
      "members",
      "Members",
      (space) => (space.kind === "shared" ? membersOf(space) : "—"),
      "whitespace-nowrap",
    ),
    {
      ...contextColumn<OrgSpace>("everyone", "Everyone", everyoneOf, "whitespace-nowrap"),
      meta: {
        label: "Everyone",
        options: EVERYONE_FILTER,
        headerClassName: "w-32",
        className: "hidden px-3 py-2.5 whitespace-nowrap text-muted-foreground sm:table-cell",
      },
    },
    contextColumn<OrgSpace>(
      "created",
      "Created",
      (space) => <Time iso={space.createdAt} />,
      "whitespace-nowrap",
    ),
    actionsColumn<OrgSpace>((space) =>
      space.kind === "shared" ? (
        <ActionsMenu
          label={space.name}
          destructive={
            space.hasThreads ? (
              <WithTooltip label="Only a space without threads can be deleted">
                <div>
                  <DropdownMenuItem variant="destructive" disabled>
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                </div>
              </WithTooltip>
            ) : (
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(space)}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            )
          }
        >
          <DropdownMenuItem onClick={() => onSettings(space)}>
            <Settings2Icon />
            Space settings
          </DropdownMenuItem>
        </ActionsMenu>
      ) : null,
    ),
    filterColumn<OrgSpace>("kind", "Kind", KIND_FILTER),
  ];
}

// The search, kind, everyone's role and page in the address.
export const orgSpacesSearchSchema = tableSearchSchema.extend({
  kind: lenient(z.enum(["shared", "personal"])),
  everyone: lenient(z.enum(["none", "viewer", "messager"])),
});

export function OrgSpaces() {
  const me = useQuery(meQuery);
  const owner = me.data?.org.kind === "team" && me.data.role === "owner";
  const search = orgSpacesRoute.useSearch();
  const navigate = orgSpacesRoute.useNavigate();
  const spaces = useQuery({ ...orgSpacesPage(search), enabled: owner });
  const [deleting, setDeleting] = useState<OrgSpace | null>(null);
  const deletion = useDeleteSpace();
  const settings = (space: OrgSpace) =>
    void navigate({ to: "/s/$spaceId/settings", params: { spaceId: space.id } });
  const table = useDataTable({
    columns: spacesColumns(settings, setDeleting),
    data: spaces.data?.items ?? [],
    rowCount: spaces.data?.total,
    getRowId: (space) => space.id,
    search,
    onSearch: (changes) =>
      void navigate({
        search: (previous) => withoutUnset({ ...previous, ...changes }),
        replace: true,
      }),
    filters: ["kind", "everyone"],
    hidden: ["kind"],
  });

  function remove() {
    if (!deleting) return;
    deletion.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
  }

  return (
    <>
      <SettingsTitle
        title="Spaces"
        description="Every space in the organization. Opening a space's settings lets you change its members, including yourself, to read its threads."
      />
      {me.data && !owner ? (
        <EmptyState
          icon={<LayoutGridIcon />}
          title="For the organization's owners"
          description="Only the organization's owners manage all its spaces."
        />
      ) : (
        <>
          <SpaceSettingsCard />
          <SettingsCard>
            <DataTable
              table={table}
              label="Spaces"
              loading={!spaces.data}
              failed={!!spaces.error}
              empty={{ icon: <LayoutGridIcon />, title: "No spaces yet" }}
              rowProps={(space) => ({
                label: space.name,
                ...(space.kind === "shared" && { onOpen: () => settings(space) }),
              })}
            >
              <DataTableToolbar table={table} search="Search spaces" />
            </DataTable>
          </SettingsCard>
        </>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (open) return;
          setDeleting(null);
          deletion.reset();
        }}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="This cannot be undone."
        error={deletion.error?.message}
        disabled={deletion.isPending}
        action="Delete"
        onConfirm={remove}
      />
    </>
  );
}
