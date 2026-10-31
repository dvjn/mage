// Who is in a shared space, titled with how roles add up: everyone in the org first (None, Viewer
// or Messager), then the people and groups given a role, searched and read a page at a time on the
// server, each person with the role they end up with and what gives it when that is not their own.
// Whoever manages the space adds people and groups, changes roles and removes them after a
// confirmation, which says when a group still covers the person. Nobody changes their own role, nor
// the last owner's.

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Building2Icon, UserMinusIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { ORG_ROLE_LABELS } from "@/shared/orgs.ts";
import {
  type SpaceGrant,
  type SpaceRole,
  spaceRoleSchema,
  type SpaceSummary,
} from "@/shared/spaces.ts";
import { AddPeopleDialog } from "@/web/spaces/add-people-dialog";
import { Peek, PeekList } from "@/web/shell/peek";
import { DataTable } from "@/web/components/data-table/data-table";
import { DataTableToolbar } from "@/web/components/data-table/data-table-toolbar";
import {
  actionsColumn,
  ActionsMenu,
  HeaderAction,
  nameColumn,
  type RoleChoice,
  roleColumn,
  RoleControl,
  Subject,
} from "@/web/shell/people-table";
import { SettingsCard, SettingsTitle } from "@/web/shell/settings-page";
import { Time } from "@/web/components/time";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { Skeleton } from "@/web/components/ui/skeleton";
import { useDataTable } from "@/web/hooks/use-data-table";
import { lenient, tableSearchSchema, withoutUnset } from "@/web/lib/data-table";
import {
  groupMembersPages,
  groupQuery,
  groupsPages,
  memberQuery,
  spaceMembersPage,
} from "@/web/api/list-queries";
import { meQuery } from "@/web/auth/queries";
import { LOCK_REASONS, ROLE_LABELS } from "@/web/spaces/roles";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { useSpaceEveryone, useSpaceGrant } from "@/web/spaces/mutations";

const ROLES = (["owner", "messager", "viewer"] as const).map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));

type Everyone = "none" | "viewer" | "messager";

// The same words as every other role; owning is not for everyone.
const EVERYONE = [
  { value: "none" as const, label: "None" },
  { value: "viewer" as const, label: ROLE_LABELS.viewer },
  { value: "messager" as const, label: ROLE_LABELS.messager },
];

const settingsRoute = getRouteApi("/_app/s/$spaceId/settings/members");

function members(count: number | null) {
  return `${count ?? 0} ${count === 1 ? "member" : "members"}`;
}

// Of the groups that cover someone, the one whose role they keep: the highest.
function keeping(groups: { name: string; role: SpaceRole }[]) {
  const rank = (role: SpaceRole) => ROLES.findIndex((option) => option.value === role);
  return groups.reduce((best, group) => (rank(group.role) < rank(best.role) ? group : best));
}

// A person at a glance: their email, their role in the org and when they joined it.
function PersonPeek({ userId, name }: { userId: string; name: string }) {
  return (
    <Peek label={`About ${name}`} trigger={name}>
      {() => <PersonCard userId={userId} />}
    </Peek>
  );
}

function PersonCard({ userId }: { userId: string }) {
  const person = useQuery(memberQuery(userId));
  if (!person.data) {
    return (
      <div className="flex flex-col gap-1.5 p-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-40" />
      </div>
    );
  }
  return (
    <div className="grid gap-0.5 p-3 text-sm leading-tight">
      <span className="font-medium">{person.data.name}</span>
      <span className="text-xs text-muted-foreground">{person.data.email}</span>
      <span className="pt-1 text-xs text-muted-foreground">
        {ORG_ROLE_LABELS[person.data.role]} · joined <Time iso={person.data.joinedAt} />
      </span>
    </div>
  );
}

// The group that gives someone a higher role, at a glance.
function ViaPeek({ grant }: { grant: SpaceGrant }) {
  const text = `${ROLE_LABELS[grant.effective]} via ${grant.via}`;
  if (!grant.viaGroupId) return <>{text}</>;
  const groupId = grant.viaGroupId;
  return (
    <Peek label={`About ${grant.via}`} trigger={text}>
      {() => <GroupCard groupId={groupId} />}
    </Peek>
  );
}

function GroupCard({ groupId }: { groupId: string }) {
  const group = useQuery(groupQuery(groupId));
  return (
    <div className="grid gap-0.5 p-3 text-sm leading-tight">
      <span className="font-medium">{group.data?.name ?? "…"}</span>
      <span className="text-xs text-muted-foreground">
        {group.data ? `Group · ${members(group.data.memberCount)}` : "Group"}
      </span>
    </div>
  );
}

// A group's members, at a glance.
function GroupMembersPeek({ row }: { row: SpaceGrant }) {
  if (!row.memberCount) return <>{members(0)}</>;
  return (
    <Peek label={`Members of ${row.name}`} trigger={members(row.memberCount)}>
      {() => (
        <PeekList
          title={`${row.name}'s members`}
          query={(q) => groupMembersPages(row.id, { q }, 20)}
          rowKey={(member) => member.userId}
          row={(member) => (
            <span className="grid leading-tight">
              <span className="truncate">{member.name}</span>
              <span className="truncate text-xs text-muted-foreground">{member.email}</span>
            </span>
          )}
          empty="Nobody yet"
        />
      )}
    </Peek>
  );
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
        options: EVERYONE,
        ...(manage && { onChange: (next: string) => setEveryone(next as Everyone) }),
      };
    }
    return {
      value: row.role,
      options: ROLES,
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
          folded={EVERYONE.find((option) => option.value === row.role)?.label}
        />
      ) : (
        <Subject
          avatar={row.kind === "group" ? { icon: <UsersIcon /> } : { initials: row.name }}
          name={row.kind === "user" ? <PersonPeek userId={row.id} name={row.name} /> : row.name}
          you={row.kind === "user" && row.id === me.data?.user.id}
          detail={
            row.kind === "group" ? (
              <>
                Group · <GroupMembersPeek row={row} />
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
      (row) => (
        <RoleControl
          label={row.kind === "everyone" ? "Everyone's role" : `Role of ${row.name}`}
          choice={roleOf(row)}
        />
      ),
      ROLES,
    ),
    actionsColumn<MemberRow>((row) =>
      row.kind === "everyone" ? (
        <ActionsMenu label={`Everyone in ${row.orgName}`} role={roleOf(row)} />
      ) : (
        <ActionsMenu
          label={row.name}
          role={roleOf(row)}
          destructive={
            manage &&
            !row.locked && (
              <DropdownMenuItem variant="destructive" onClick={() => setRemoving(row)}>
                <UserMinusIcon />
                Remove
              </DropdownMenuItem>
            )
          }
        />
      ),
    ),
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
        <AddPeopleDialog
          open={adding}
          onOpenChange={setAdding}
          title={`Add people to ${space.name}`}
          kinds={["user", "group"]}
          exclude={new Set(grants.map((row) => `${row.kind}:${row.id}`))}
          roles={{ options: ROLES, initial: "messager" }}
          canInvite={me.data?.role === "owner"}
          onAdd={(option, role) => grant(option, role)}
        />
        <ConfirmDialog
          open={!!removing}
          onOpenChange={(open) => {
            if (open) return;
            setRemoving(null);
            removal.reset();
          }}
          title={`Remove ${removing?.name ?? ""}?`}
          description={
            removing?.kind === "group"
              ? "Its people lose access unless they're added another way."
              : removing && removing.coveredBy.length > 0
                ? `They stay in through ${keeping(removing.coveredBy).name} as ${ROLE_LABELS[keeping(removing.coveredBy).role]}.`
                : "They lose access to this space."
          }
          error={removal.error?.message}
          disabled={removal.isPending}
          action="Remove"
          onConfirm={remove}
        />
      </SettingsCard>
    </>
  );
}
