// A team org's people in one table, searched and narrowed on the server with the values in the
// address: for its owners, the invites not yet used first, then its linked directory groups, then
// its members, with their role, the group they are in through when they are, and when they joined.
// Owners change roles and remove members, groups and invites, each after a confirmation; nobody
// changes their own role, and the last owner in their own right stays one. Someone in only through
// a group has no row of their own: the group's row stands for them, and they leave when it is
// removed or the directory takes them out of it. A personal org has only its person.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { MailIcon, MailXIcon, UserMinusIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import {
  ORG_ROLE_LABELS,
  type OrgPerson,
  type OrgRole,
  orgRoleSchema,
  personStatusSchema,
} from "@/shared/orgs.ts";
import { EmptyState } from "@/web/components/page-states";
import { DataTable } from "@/web/components/data-table/data-table";
import { DataTableToolbar } from "@/web/components/data-table/data-table-toolbar";
import {
  actionsColumn,
  ActionsMenu,
  contextColumn,
  filterColumn,
  HeaderAction,
  nameColumn,
  type RoleChoice,
  roleColumn,
  RoleControl,
  Subject,
} from "@/web/shell/people-table";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { Time } from "@/web/components/time";
import { Badge } from "@/web/components/ui/badge";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { useDataTable } from "@/web/hooks/use-data-table";
import { type FilterOption, lenient, tableSearchSchema, withoutUnset } from "@/web/lib/data-table";
import {
  directoryGroupsPages,
  directoryPeoplePages,
  groupsPages,
  peoplePage,
} from "@/web/api/list-queries";
import { meQuery } from "@/web/auth/queries";
import { LOCK_REASONS } from "@/web/spaces/roles";
import { timeUntil } from "@/web/lib/time";
import { plural } from "@/web/lib/plural";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { ROLE_OPTIONS } from "@/web/orgs/role-select";
import { AddPeopleDialog } from "@/web/orgs/add-people-dialog";
import { GroupMembersPeek, ViaGroups } from "@/web/orgs/people-peeks";
import { useOrgRemoval, useOrgRole } from "@/web/orgs/mutations";

// The search, role, status and page in the address.
export const peopleSearchSchema = tableSearchSchema.extend({
  role: lenient(orgRoleSchema),
  status: lenient(personStatusSchema),
});

export type Member = Extract<OrgPerson, { kind: "member" }>;

export type LinkedGroup = Extract<OrgPerson, { kind: "group" }>;

const peopleRoute = getRouteApi("/_app/org/people");

const STATUS_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "invited", label: "Invited" },
];

// With linked groups, they can be narrowed to as well.
const GROUP_STATUS = { value: "group", label: "Group" };

export function OrgPeople() {
  const search = peopleRoute.useSearch();
  const navigate = peopleRoute.useNavigate();
  const me = useQuery(meQuery);
  const team = me.data?.org.kind === "team";
  const manages = team && me.data?.role === "owner";
  const people = useQuery({ ...peoplePage(search), enabled: team });
  // Groups come from a directory; while the org has none linked, its filter leaves them out.
  const groups = useInfiniteQuery({ ...groupsPages({}, 1), enabled: team });
  const withGroups = (groups.data?.pages[0]?.total ?? 0) > 0;
  // What the directory offers owners to add, if the server has one.
  const directoryPeople = useInfiniteQuery({
    ...directoryPeoplePages({}, 1),
    enabled: !!manages,
  });
  const directoryGroups = useInfiniteQuery({
    ...directoryGroupsPages({}, 1),
    enabled: !!manages,
  });
  const directory = {
    people: (directoryPeople.data?.pages[0]?.total ?? 0) > 0,
    groups: (directoryGroups.data?.pages[0]?.total ?? 0) > 0,
  };
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OrgPerson | null>(null);
  const roleChange = useOrgRole();
  const removeMutation = useOrgRemoval();

  function remove() {
    if (!removing) return;
    removeMutation.mutate(
      { kind: removing.kind, id: removing.kind === "member" ? removing.userId : removing.id },
      { onSuccess: () => setRemoving(null) },
    );
  }

  const statusOptions = [
    STATUS_OPTIONS[0]!,
    ...(manages ? [STATUS_OPTIONS[1]!] : []),
    ...(withGroups ? [GROUP_STATUS] : []),
  ];
  const columns = peopleColumns({
    you: me.data?.user.id,
    manages: !!manages,
    status: statusOptions.length > 1 ? statusOptions : null,
    onRole: (person, role) => {
      if (person.kind === "group") roleChange.mutate({ kind: "group", id: person.id, role });
      if (person.kind === "member") roleChange.mutate({ kind: "member", id: person.userId, role });
    },
    onRemove: setRemoving,
  });
  const table = useDataTable({
    columns,
    data: people.data?.items ?? [],
    rowCount: people.data?.total,
    getRowId: (person) => `${person.kind}:${person.kind === "member" ? person.userId : person.id}`,
    search,
    onSearch: (changes) =>
      void navigate({
        search: (previous) => withoutUnset({ ...previous, ...changes }),
        replace: true,
      }),
    filters: ["role", "status"],
    hidden: ["status"],
  });
  const removal = removing && removalOf(removing, me.data?.org.name ?? "");

  return (
    <>
      <SettingsTitle
        title="People"
        description={me.data ? `The people in ${me.data.org.name}.` : undefined}
      />
      {me.data && !team ? (
        <EmptyState
          icon={<UsersIcon />}
          title="Only you"
          description="Your personal organization has only you in it. Make a new organization from the space menu to work with others."
        />
      ) : (
        <SettingsCard>
          <DataTable
            table={table}
            label="People"
            loading={!people.data}
            failed={!!people.error}
            empty={{ icon: <UsersIcon />, title: "Nobody is here yet" }}
            rowProps={(person) => ({
              label: person.kind === "invite" ? person.email : person.name,
            })}
          >
            <DataTableToolbar
              table={table}
              search="Search people"
              action={
                manages && (
                  <HeaderAction
                    icon={<UserPlusIcon />}
                    label="Add people"
                    onClick={() => setAdding(true)}
                  />
                )
              }
            />
            <FieldError>{roleChange.error?.message}</FieldError>
          </DataTable>
        </SettingsCard>
      )}
      <AddPeopleDialog open={adding} onOpenChange={setAdding} directory={directory} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (open) return;
          setRemoving(null);
          removeMutation.reset();
        }}
        title={removal?.title}
        description={removal?.description}
        error={removeMutation.error?.message}
        disabled={removeMutation.isPending}
        action="Remove"
        onConfirm={remove}
      />
    </>
  );
}

// What removing a row asks: a member who is also in through a group loses only their own role.
function removalOf(person: OrgPerson, orgName: string) {
  if (person.kind === "invite") {
    return {
      title: `Remove the invite for ${person.email}?`,
      description: "The link stops working.",
    };
  }
  if (person.kind === "group") {
    return {
      title: `Remove ${person.name}?`,
      description: "Its people lose access unless they're added another way.",
    };
  }
  return {
    title: `Remove ${person.name}?`,
    description: person.groupRole
      ? `They stay in through ${groupsOf(person)} as ${ORG_ROLE_LABELS[person.groupRole]}.`
      : `They lose access to ${orgName} and its spaces.`,
  };
}

// The linked groups a member is in, as "Engineering" or "Design and 1 other".
export function groupsOf(person: Member) {
  return person.groupCount <= 1
    ? (person.viaGroup ?? "")
    : `${person.viaGroup} and ${plural(person.groupCount - 1, "other", "others")}`;
}

// The role a row has, and for whoever manages the org, changing it, unless it is locked.
function roleOf(
  person: OrgPerson,
  manages: boolean,
  onRole: (person: OrgPerson, role: OrgRole) => void,
): RoleChoice<OrgRole> {
  if (person.kind === "invite") return { value: person.role, options: ROLE_OPTIONS };
  return {
    value: person.role,
    options: ROLE_OPTIONS,
    ...(manages && { onChange: (role: OrgRole) => onRole(person, role) }),
    ...(manages &&
      person.kind === "member" &&
      person.locked && { locked: LOCK_REASONS.org[person.locked] }),
  };
}

// The invite's, group's or member's name; their role; when they joined, or the group was linked;
// and their menu. The status, member, invited or group, only narrows them.
function peopleColumns({
  you,
  manages,
  status,
  onRole,
  onRemove,
}: {
  you: string | undefined;
  manages: boolean;
  status: FilterOption[] | null;
  onRole: (person: OrgPerson, role: OrgRole) => void;
  onRemove: (person: OrgPerson) => void;
}) {
  const remove = (person: OrgPerson, icon: React.ReactNode) => (
    <DropdownMenuItem variant="destructive" onClick={() => onRemove(person)}>
      {icon}
      Remove
    </DropdownMenuItem>
  );
  return [
    nameColumn<OrgPerson>("Name", (person) =>
      person.kind === "invite" ? (
        <Subject
          avatar={{ icon: <MailIcon /> }}
          name={person.email}
          detail={`${person.createdByName ? `Invited by ${person.createdByName} · ` : "Invited · "}expires ${timeUntil(person.expiresAt) ?? "now"}`}
          folded={ORG_ROLE_LABELS[person.role]}
        />
      ) : person.kind === "group" ? (
        <Subject
          avatar={{ icon: <UsersIcon /> }}
          name={
            <>
              {person.name}{" "}
              <Badge variant="secondary" className="ml-1 rounded-sm px-1 align-middle font-normal">
                Directory
              </Badge>
            </>
          }
          detail={<GroupMembersPeek group={person} />}
          folded={ORG_ROLE_LABELS[person.role]}
        />
      ) : (
        <Subject
          avatar={{ initials: person.name }}
          name={person.name}
          you={person.userId === you}
          detail={person.email}
          note={person.viaGroup && <ViaGroups person={person} />}
          folded={ORG_ROLE_LABELS[person.role]}
        />
      ),
    ),
    roleColumn<OrgPerson>(
      (person) => (
        <RoleControl
          label={`Role of ${person.kind === "invite" ? person.email : person.name}`}
          choice={roleOf(person, manages, onRole)}
        />
      ),
      ROLE_OPTIONS,
    ),
    contextColumn<OrgPerson>(
      "joined",
      "Joined",
      (person) =>
        person.kind === "invite" ? (
          "—"
        ) : (
          <Time iso={person.kind === "group" ? person.linkedAt : person.joinedAt} />
        ),
      "whitespace-nowrap",
    ),
    actionsColumn<OrgPerson>((person) =>
      person.kind === "invite" ? (
        <ActionsMenu label={person.email} destructive={remove(person, <MailXIcon />)} />
      ) : (
        <ActionsMenu
          label={person.name}
          role={roleOf(person, manages, onRole)}
          destructive={
            manages &&
            !(person.kind === "member" && person.userId === you) &&
            remove(person, <UserMinusIcon />)
          }
        />
      ),
    ),
    ...(status ? [filterColumn<OrgPerson>("status", "Status", status)] : []),
  ];
}
