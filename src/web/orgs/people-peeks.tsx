// Glances from the people tables, org's and space's: a person, a group and its people, and the
// groups someone is in through.

import { useQuery } from "@tanstack/react-query";

import { ORG_ROLE_LABELS } from "@/shared/orgs.ts";
import { Time } from "@/web/components/time";
import { Skeleton } from "@/web/components/ui/skeleton";
import { Peek, PeekList } from "@/web/shell/peek";
import {
  groupMembersPages,
  groupQuery,
  memberGroupsPages,
  memberQuery,
} from "@/web/api/list-queries";
import { plural } from "@/web/lib/plural";
import { type Member, groupsOf } from "@/web/orgs/people-page";

// A person at a glance: their email, their role in the org and when they joined it.
export function PersonPeek({ userId, name }: { userId: string; name: string }) {
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

// A group at a glance, and how many people are in it.
export function GroupPeek({
  groupId,
  text,
  label,
}: {
  groupId: string;
  text: string;
  label: string;
}) {
  return (
    <Peek label={label} trigger={text}>
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
        {group.data ? `Group · ${plural(group.data.memberCount, "person", "people")}` : "Group"}
      </span>
    </div>
  );
}

// The linked group a member is in through, and at a glance every one of them when there are more.
export function ViaGroups({ person }: { person: Member }) {
  if (!person.viaGroup) return null;
  if (person.groupCount <= 1) return <>via {person.viaGroup}</>;
  return (
    <>
      via{" "}
      <Peek label={`Groups of ${person.name}`} trigger={groupsOf(person)}>
        {() => (
          <PeekList
            title={`${person.name}'s groups`}
            query={(q) => memberGroupsPages(person.userId, { q }, 20)}
            rowKey={(group) => group.id}
            row={(group) => (
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate">{group.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {ORG_ROLE_LABELS[group.role]}
                </span>
              </span>
            )}
            empty="In no groups"
          />
        )}
      </Peek>
    </>
  );
}

// A group's people, at a glance.
export function GroupMembersPeek({
  group,
}: {
  group: { id: string; name: string; memberCount: number | null };
}) {
  const count = plural(group.memberCount ?? 0, "person", "people");
  if (!group.memberCount) return <>{count}</>;
  return (
    <Peek label={`People in ${group.name}`} trigger={count}>
      {() => (
        <PeekList
          title={`People in ${group.name}`}
          query={(q) => groupMembersPages(group.id, { q }, 20)}
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
