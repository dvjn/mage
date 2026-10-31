// Glances from the people table: the groups someone is in through, and a group's members.

import { ORG_ROLE_LABELS } from "@/shared/orgs.ts";
import { Peek, PeekList } from "@/web/shell/peek";
import { groupMembersPages, memberGroupsPages } from "@/web/api/list-queries";
import { plural } from "@/web/lib/plural";
import { type LinkedGroup, type Member, groupsOf } from "@/web/orgs/people-page";

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
export function GroupMembersPeek({ group }: { group: LinkedGroup }) {
  const count = plural(group.memberCount, "person", "people");
  if (group.memberCount === 0) return <>{count}</>;
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
