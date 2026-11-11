// Who is in a shared space, titled with how roles add up: everyone in the org first (None, View
// or Message), then the people and groups given a role, searched and read a page at a time on the
// server, each person with the role they end up with and what gives it when that is not their own.
// Whoever manages the space adds people and groups, changes roles and removes them after a
// confirmation, which says when a group still covers the person. Nobody changes their own role, nor
// the last owner's.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Building2Icon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import {
  type SpaceGrant,
  type SpaceRole,
  spaceRoleSchema,
  type SpaceSummary,
} from "@/shared/spaces.ts";
import { AddPeopleToSpace } from "@/web/spaces/add-people-dialog";
import { GroupMembersPeek, GroupPeek, PersonPeek } from "@/web/orgs/people-peeks";
import { DataTable } from "@/web/components/data-table/data-table";
import { DataTableToolbar } from "@/web/components/data-table/data-table-toolbar";
import {
  actionsColumn,
  HeaderAction,
  nameColumn,
  RemoveButton,
  RemoveConfirm,
  removalCopy,
  type RoleChoice,
  roleColumn,
  RoleMenu,
  RowActions,
  Subject,
} from "@/web/shell/people-table";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { FieldError } from "@/web/components/ui/field";
import { useDataTable } from "@/web/hooks/use-data-table";
import { lenient, tableSearchSchema, withoutUnset } from "@/web/lib/data-table";
import { groupsPages, spaceMembersPage } from "@/web/api/list-queries";
import { meQuery } from "@/web/auth/queries";
import { LOCK_REASONS, ROLE_LABELS } from "@/web/spaces/roles";
import { EVERYONE_LEVELS, SPACE_ROLE_LEVELS } from "@/web/sharing/access-level";
import { useSpaceEveryone, useSpaceGrant } from "@/web/spaces/mutations";

type Everyone = "none" | "viewer" | "messager";

const settingsRoute = getRouteApi("/_app/s/$spaceId/settings/members");

// Of the groups that cover someone, the one whose role they keep: the highest.
function keeping(groups: { name: string; role: SpaceRole }[]) {
  const rank = (role: SpaceRole) => SPACE_ROLE_LEVELS.findIndex((level) => level.value === role);
  return groups.reduce((best, group) => (rank(group.role) < rank(best.role) ? group : best));
}

// The group that gives someone a higher role, at a glance.
function ViaPeek({ grant }: { grant: SpaceGrant }) {
  const text = `${ROLE_LABELS[grant.effective]} via ${grant.via}`;
  if (!grant.viaGroupId) return <>{text}</>;
  return <GroupPeek groupId={grant.viaGroupId} label={`About ${grant.via}`} text={text} />;
}

// The everyone row, or a person's or group's.
type MemberRow = { kind: "everyone"; orgName: string; role: Everyone } | SpaceGrant;

// The search, role and page in the address.
export const spaceMembersSearchSchema = tableSearchSchema.extend({
  role: lenient(spaceRoleSchema),
});

export function SpaceMembers({ space }: { space: SpaceSummary }) {
  const search = settingsRoute.useSearch();
  const navigate = settingsRoute.useNavigate();
  const me = useQuery(meQuery);
  const list = useQuery(spaceMembersPage(space.id)(search));
  // Groups come from a directory; while the org has none, nothing speaks of them.
  const groups = useInfiniteQuery(groupsPages({}, 1));
  const withGroups = (groups.data?.pages[0]?.total ?? 0) > 0;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SpaceGrant | null>(null);
  const roleChange = useSpaceGrant(space.id);
  const removal = useSpaceGrant(space.id);
  const adder = useSpaceGrant(space.id);
  const everyone = useSpaceEveryone(space.id);
  const error = (roleChange.error ?? everyone.error)?.message;

  function change(row: SpaceGrant, role: SpaceRole) {
    everyone.reset();
    roleChange.mutate({ kind: row.kind, id: row.id, role });
  }

  function grant(subject: { kind: "user" | "group"; id: string }, role: SpaceRole | null) {
    return adder.mutateAsync({ kind: subject.kind, id: subject.id, role }).then(
      () => undefined,
      (failed: Error) => failed.message,
    );
  }

  function remove() {
    if (!removing) return;
    removal.mutate(
      { kind: removing.kind, id: removing.id, role: null },
      { onSuccess: () => setRemoving(null) },
    );
  }

  function setEveryone(next: Everyone) {
    roleChange.reset();
    everyone.mutate(next === "none" ? null : next);
  }

  const first = list.data;
  const grants = first?.grants.items ?? [];
  const manage = space.manage;
  // The everyone row stands above the people on the first page, unless a search or filter narrows
  // them.
  const showEveryone = !!first && !search.q && !search.role && !search.page;
  const rows: MemberRow[] = [
    ...(showEveryone
      ? [
          {
            kind: "everyone" as const,
            orgName: first.orgName,
            role: (first.everyoneRole ?? "none") as Everyone,
          },
        ]
      : []),
    ...grants,
  ];

  function roleOf(row: MemberRow): RoleChoice<string> {
    if (row.kind === "everyone") {
      return {
        value: row.role,
        levels: EVERYONE_LEVELS,
        ...(manage && { onChange: (next: string) => setEveryone(next as Everyone) }),
      };
    }
    return {
      value: row.role,
      levels: SPACE_ROLE_LEVELS,
      ...(manage && { onChange: (next: string) => change(row, next as SpaceRole) }),
      ...(manage && row.locked && { locked: LOCK_REASONS.space[row.locked] }),
    };
  }

  const columns = [
    nameColumn<MemberRow>("Name", (row) =>
      row.kind === "everyone" ? (
        <Subject
          avatar={{ icon: <Building2Icon /> }}
          name={`Everyone in ${row.orgName}`}
          detail="Current and future members"
          folded={EVERYONE_LEVELS.find((level) => level.value === row.role)?.label}
        />
      ) : (
        <Subject
          avatar={row.kind === "group" ? { icon: <UsersIcon /> } : { initials: row.name }}
          name={row.kind === "user" ? <PersonPeek userId={row.id} name={row.name} /> : row.name}
          you={row.kind === "user" && row.id === me.data?.user.id}
          detail={
            row.kind === "group" ? (
              <>
                Group · <GroupMembersPeek group={row} />
              </>
            ) : (
              row.email
            )
          }
          note={row.via && <ViaPeek grant={row} />}
          folded={ROLE_LABELS[row.role]}
        />
      ),
    ),
    roleColumn<MemberRow>(
      (row) => ({
        label: row.kind === "everyone" ? "Everyone's role" : `Role of ${row.name}`,
        ...roleOf(row),
      }),
      SPACE_ROLE_LEVELS.map(({ value, label }) => ({ value, label })),
    ),
    actionsColumn<MemberRow>((row) => (
      <RowActions>
        <RoleMenu
          name={row.kind === "everyone" ? `Everyone in ${row.orgName}` : row.name}
          role={roleOf(row)}
        />
        {row.kind !== "everyone" && manage && !row.locked && (
          <RemoveButton name={row.name} onClick={() => setRemoving(row)} />
        )}
      </RowActions>
    )),
  ];
  const table = useDataTable({
    columns,
    data: rows,
    rowCount: first?.grants.total,
    getRowId: (row) => (row.kind === "everyone" ? "everyone" : `${row.kind}:${row.id}`),
    search,
    onSearch: (changes) =>
      void navigate({
        search: (previous) => withoutUnset({ ...previous, ...changes }),
        replace: true,
      }),
    filters: ["role"],
  });

  return (
    <>
      <SettingsTitle
        title="Members"
        description={`Who can read and write in this space. Each person has the highest role given to them${withGroups ? ", to a group they are in," : ""} or to everyone.${manage ? "" : " Only the space's owners change this."}`}
      />
      <SettingsCard>
        <DataTable
          table={table}
          label="Members"
          loading={!first}
          failed={!!list.error}
          empty={{ icon: <UsersIcon />, title: "Nobody is in this space" }}
          rowProps={(row) => ({
            label: row.kind === "everyone" ? `Everyone in ${row.orgName}` : row.name,
          })}
        >
          <DataTableToolbar
            table={table}
            search="Search members"
            action={
              manage && (
                <HeaderAction
                  icon={<UserPlusIcon />}
                  label="Add people"
                  onClick={() => setAdding(true)}
                />
              )
            }
          />
          <FieldError>{error}</FieldError>
        </DataTable>
        <AddPeopleToSpace
          open={adding}
          onOpenChange={setAdding}
          title={`Add people to ${space.name}`}
          exclude={new Set(grants.map((row) => `${row.kind}:${row.id}`))}
          canInvite={me.data?.role === "owner"}
          onAdd={(option, role) => grant(option, role)}
        />
        <RemoveConfirm
          subject={
            removing &&
            (removing.kind === "group"
              ? removalCopy("group", removing.name)
              : removalCopy(
                  "person",
                  removing.name,
                  removing.coveredBy.length > 0
                    ? `${keeping(removing.coveredBy).name} as ${ROLE_LABELS[keeping(removing.coveredBy).role]}`
                    : undefined,
                ))
          }
          onClose={() => {
            setRemoving(null);
            removal.reset();
          }}
          error={removal.error?.message}
          disabled={removal.isPending}
          onConfirm={remove}
        />
      </SettingsCard>
    </>
  );
}
