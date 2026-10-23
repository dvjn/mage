// Who is in a shared space: everyone in the org first (None, Viewer or Messager), then the people
// and groups given a role, searched and read a page at a time on the server, each person with the
// role they end up with and what gives it when that is not their own. Whoever manages the space
// adds people and groups, changes roles and removes them; removing a person a group still covers
// says so first. Nobody changes their own role, nor the last owner's.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Building2Icon, UserMinusIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { ORG_ROLE_LABELS } from "@/shared/orgs.ts";
import type { SpaceGrant, SpaceRole, SpaceSummary } from "@/shared/spaces.ts";
import { AddPeopleDialog } from "@/web/components/add-people-dialog";
import { ListSkeleton, LoadError } from "@/web/components/page-states";
import { Peek, PeekList } from "@/web/components/peek";
import {
  ActionsCell,
  HeaderAction,
  LoadMore,
  PeopleRow,
  PeopleTable,
  ROLE_COLUMN,
  RoleCell,
  SubjectCell,
} from "@/web/components/people-table";
import { SettingsCard } from "@/web/components/settings/layout";
import { TableToolbar, useSearchText } from "@/web/components/table-toolbar";
import { Time } from "@/web/components/time";
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
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import { FieldError } from "@/web/components/ui/field";
import { Skeleton } from "@/web/components/ui/skeleton";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import {
  groupMembersPages,
  groupQuery,
  groupsPages,
  memberQuery,
  spaceMembersPages,
} from "@/web/lib/list-queries";
import { meQuery, spacesQuery } from "@/web/lib/queries";
import { LOCK_REASONS, ROLE_LABELS } from "@/web/lib/roles";

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

const settingsRoute = getRouteApi("/_app/s/$spaceId/settings");

function members(count: number | null) {
  return `${count ?? 0} ${count === 1 ? "member" : "members"}`;
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

export function SpaceMembers({ space }: { space: SpaceSummary }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = settingsRoute.useSearch();
  const me = useQuery(meQuery);
  const list = useInfiniteQuery(
    spaceMembersPages(space.id, { q: search.q, ...(search.role && { role: search.role }) }),
  );
  // Groups come from a directory; while the org has none, nothing speaks of them.
  const groups = useInfiniteQuery(groupsPages({}, 1));
  const withGroups = (groups.data?.pages[0]?.total ?? 0) > 0;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<SpaceGrant | null>(null);
  const [removeError, setRemoveError] = useState<string>();

  function set(changes: { q?: string; role?: SpaceRole | undefined }) {
    void navigate({
      to: "/s/$spaceId/settings",
      params: { spaceId: space.id },
      search: (() => {
        const next: { q?: string; role?: SpaceRole } = { ...search, ...changes };
        return { ...(next.q && { q: next.q }), ...(next.role && { role: next.role }) };
      })(),
      replace: true,
    });
  }
  const [text, setText] = useSearchText(search.q ?? "", (q) => set({ q }));
  const filtered = !!(search.q || search.role);
  const clear = () => set({ q: undefined, role: undefined });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["space-members", space.id] }),
      queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ["org-spaces"] }),
    ]);
  }

  async function grant(subject: { kind: "user" | "group"; id: string }, role: SpaceRole | null) {
    const res = await apiClient.v1.spaces[":id"].members.$put({
      param: { id: space.id },
      json: { kind: subject.kind, id: subject.id, role },
    });
    if (!res.ok) return errorOf(res);
    await refresh();
    return undefined;
  }

  async function change(row: SpaceGrant, role: SpaceRole) {
    setError(await grant(row, role));
  }

  async function remove() {
    if (!removing) return;
    const failed = await grant(removing, null);
    setRemoveError(failed);
    if (!failed) setRemoving(null);
  }

  async function setEveryone(next: Everyone) {
    setError(undefined);
    const res = await apiClient.v1.spaces[":id"].everyone.$put({
      param: { id: space.id },
      json: { role: next === "none" ? null : next },
    });
    if (!res.ok) setError(await errorOf(res));
    await refresh();
  }

  const first = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((page) => page.grants.items) ?? [];
  const manage = space.manage;
  const everyone = {
    value: (first?.everyoneRole ?? "none") as Everyone,
    options: EVERYONE,
    ...(manage && { onChange: (next: Everyone) => void setEveryone(next) }),
  };
  // The everyone row stands above the people, unless a search or filter narrows them.
  const showEveryone = !filtered;

  return (
    <SettingsCard
      title="Members"
      description={`Who can read and write in this space. Each person has the highest role given to them${withGroups ? ", to a group they are in," : ""} or to everyone.${manage ? "" : " Only the space's owners change this."}`}
      action={
        manage && (
          <HeaderAction
            icon={<UserPlusIcon />}
            label="Add people"
            onClick={() => setAdding(true)}
          />
        )
      }
    >
      <div className="flex flex-col gap-2">
        <TableToolbar
          search={{ label: "Search members", value: text, onChange: setText }}
          filters={[
            {
              label: "Role",
              value: search.role,
              options: ROLES,
              onChange: (role) => set({ role: role as SpaceRole | undefined }),
            },
          ]}
          total={first?.grants.total}
          onReset={clear}
        />
        <FieldError>{error}</FieldError>
        {list.error ? (
          <LoadError />
        ) : !first ? (
          <ListSkeleton />
        ) : (
          <PeopleTable
            label="Members"
            columns={[ROLE_COLUMN]}
            count={rows.length + (showEveryone ? 1 : 0)}
            empty={{ icon: <UsersIcon />, title: "Nobody is in this space" }}
            {...(filtered && { filtered: { onClear: clear } })}
          >
            {showEveryone && (
              <PeopleRow label={`Everyone in ${first.orgName}`}>
                <SubjectCell
                  avatar={{ icon: <Building2Icon /> }}
                  name={`Everyone in ${first.orgName}`}
                  detail="Current and future members"
                  folded={EVERYONE.find((option) => option.value === everyone.value)?.label}
                />
                <RoleCell label="Everyone's role" choice={everyone} />
                <ActionsCell label={`Everyone in ${first.orgName}`} role={everyone} />
              </PeopleRow>
            )}
            {rows.map((row) => {
              const role = {
                value: row.role,
                options: ROLES,
                ...(manage && { onChange: (next: SpaceRole) => void change(row, next) }),
                ...(manage && row.locked && { locked: LOCK_REASONS.space[row.locked] }),
              };
              return (
                <PeopleRow key={`${row.kind}:${row.id}`} label={row.name}>
                  <SubjectCell
                    avatar={row.kind === "group" ? { icon: <UsersIcon /> } : { initials: row.name }}
                    name={
                      row.kind === "user" ? (
                        <PersonPeek userId={row.id} name={row.name} />
                      ) : (
                        row.name
                      )
                    }
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
                  <RoleCell label={`Role of ${row.name}`} choice={role} />
                  <ActionsCell
                    label={row.name}
                    role={role}
                    destructive={
                      manage &&
                      !row.locked && (
                        <DropdownMenuItem variant="destructive" onClick={() => setRemoving(row)}>
                          <UserMinusIcon />
                          Remove from space…
                        </DropdownMenuItem>
                      )
                    }
                  />
                </PeopleRow>
              );
            })}
          </PeopleTable>
        )}
        <LoadMore
          more={!!list.hasNextPage}
          loading={list.isFetchingNextPage}
          onLoad={() => void list.fetchNextPage()}
        />
      </div>
      <AddPeopleDialog
        open={adding}
        onOpenChange={setAdding}
        title={`Add people to ${space.name}`}
        kinds={["user", "group"]}
        exclude={new Set(rows.map((row) => `${row.kind}:${row.id}`))}
        roles={{ options: ROLES, initial: "messager" }}
        canInvite={me.data?.role === "owner"}
        onAdd={(option, role) => grant(option, role)}
      />
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (open) return;
          setRemoving(null);
          setRemoveError(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.name} from {space.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.kind === "group"
                ? "Its members keep any role given to them another way."
                : removing && removing.coveredBy.length > 0
                  ? `${removing.coveredBy.map((group) => group.name).join(", ")} still ${removing.coveredBy.length === 1 ? "gives" : "give"} them the ${ROLE_LABELS[removing.coveredBy[0]!.role].toLowerCase()} role. Remove them from the group too to take it away.`
                  : "They can no longer read this space's threads, unless everyone in the organization can."}
            </AlertDialogDescription>
            <FieldError>{removeError}</FieldError>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
