// A team org's people in one table, searched and narrowed on the server with the values in the
// address: for its owners, the invites not yet used first, then its linked directory groups, then
// its members, with their role, the group they are in through when they are, and when they joined.
// Owners add people from the directory or invite them by email with a link shown once, link the
// directory's groups with a role, change roles, and remove members, groups and invites, each after
// a confirmation; nobody changes their own role, and the last owner in their own right stays one.
// Someone in only through a group has no row of their own: the group's row stands for them, and
// they leave when it is removed or the directory takes them out of it. A personal org has only its
// person.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  CheckIcon,
  MailIcon,
  MailXIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type * as React from "react";
import { useId, useState } from "react";
import * as z from "zod";
import { cn } from "cn";

import {
  type CreatedOrgInvite,
  createdOrgInviteSchema,
  ORG_ROLE_LABELS,
  type OrgPerson,
  type OrgRole,
  orgRoleSchema,
  personStatusSchema,
} from "@/shared/orgs.ts";
import { CopyButton } from "@/web/components/copy-button";
import { EmptyState } from "@/web/components/page-states";
import { Peek, PeekList } from "@/web/components/peek";
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
} from "@/web/components/people-table";
import { SettingsCard, SettingsTitle } from "@/web/settings/layout";
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
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { DropdownMenuItem } from "@/web/components/ui/dropdown-menu";
import { FieldError, FieldLabel } from "@/web/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { useDataTable } from "@/web/hooks/use-data-table";
import { useDebounced } from "@/web/hooks/use-debounced";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { type FilterOption, lenient, tableSearchSchema, withoutUnset } from "@/web/lib/data-table";
import { initialsOf } from "@/web/lib/initials";
import {
  directoryGroupsPages,
  directoryPeoplePages,
  groupMembersPages,
  groupsPages,
  memberGroupsPages,
  membersPages,
  peoplePage,
} from "@/web/api/list-queries";
import { meQuery } from "@/web/auth/queries";
import { LOCK_REASONS } from "@/web/spaces/roles";
import { timeUntil } from "@/web/lib/time";

// The search, role, status and page in the address.
export const peopleSearchSchema = tableSearchSchema.extend({
  role: lenient(orgRoleSchema),
  status: lenient(personStatusSchema),
});

type Member = Extract<OrgPerson, { kind: "member" }>;
type LinkedGroup = Extract<OrgPerson, { kind: "group" }>;

const peopleRoute = getRouteApi("/_app/org/people");

const ROLES: OrgRole[] = ["member", "owner"];
const ROLE_OPTIONS = ROLES.map((value) => ({ value, label: ORG_ROLE_LABELS[value] }));

const STATUS_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "invited", label: "Invited" },
];

// With linked groups, they can be narrowed to as well.
const GROUP_STATUS = { value: "group", label: "Group" };

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

const emailSchema = z.email();

function OrgRoleSelect({
  value,
  onChange,
  label,
}: {
  value: OrgRole;
  onChange: (role: OrgRole) => void;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as OrgRole)}>
      <SelectTrigger size="sm" aria-label={label} className="w-28">
        <SelectValue>{(role: OrgRole) => ORG_ROLE_LABELS[role]}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {ROLE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// What the add dialog has picked from the directory.
type Pick = { kind: "user" | "group"; id: string; name: string };

// A suggestion in the add dialog: an avatar, a name with a muted line, and on the right what can
// be done with it. A pickable one is a button; once picked it holds the role to give.
function Suggestion({
  avatar,
  name,
  detail,
  picked,
  onPick,
  children,
}: {
  avatar: React.ReactNode;
  name: React.ReactNode;
  detail?: string;
  picked?: boolean;
  onPick?: () => void;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <Avatar size="sm">
        <AvatarFallback className="text-[0.625rem] font-medium [&_svg]:size-3">
          {avatar}
        </AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm">{name}</span>
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
    </>
  );
  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-md py-1.5",
        onPick && "-mx-2 px-2",
        picked && "bg-muted",
      )}
    >
      {onPick ? (
        <button
          type="button"
          aria-pressed={picked}
          onClick={onPick}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {children}
    </li>
  );
}

function Already({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <CheckIcon className="size-3" />
      {children}
    </span>
  );
}

// Adds people to the org. The text searches the directory's groups and people and who is in the
// org already; a group or person picked from the directory is linked or added with a role, and an
// email not among them can be invited with a role, which makes a link shown once. Without a
// directory, everyone is added by inviting their email.
function AddPeopleDialog({
  open,
  onOpenChange,
  directory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The server is connected to a directory with people or groups in it.
  directory: { people: boolean; groups: boolean };
}) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const [role, setRole] = useState<OrgRole>("member");
  const [picked, setPicked] = useState<Pick | null>(null);
  const [created, setCreated] = useState<CreatedOrgInvite>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const found = useInfiniteQuery({ ...membersPages({ q }, 6), enabled: open && !!q });
  const people = useInfiniteQuery({
    ...directoryPeoplePages({ q }, 6),
    enabled: open && !!q && directory.people,
  });
  const groups = useInfiniteQuery({
    ...directoryGroupsPages({ q }, 4),
    enabled: open && !!q && directory.groups,
  });
  const fromDirectory = people.data?.pages[0]?.items ?? [];
  const inDirectory = new Set(fromDirectory.map((person) => person.userId));
  const matches = (found.data?.pages[0]?.items ?? []).filter(
    (member) => !inDirectory.has(member.userId),
  );
  const groupMatches = groups.data?.pages[0]?.items ?? [];
  const email = text.trim().toLowerCase();
  const isEmail = emailSchema.safeParse(email).success;
  const known = [...matches, ...fromDirectory].find(
    (person) => person.email.toLowerCase() === email,
  );
  const inviting = !picked && isEmail && !known;
  const nothing =
    !!q &&
    !isEmail &&
    !!found.data &&
    matches.length === 0 &&
    fromDirectory.length === 0 &&
    groupMatches.length === 0;
  const anyDirectory = directory.people || directory.groups;

  function change(next: boolean) {
    onOpenChange(next);
    if (next) return;
    setText("");
    setCreated(undefined);
    setError(undefined);
    setRole("member");
    setPicked(null);
  }

  function pick(next: Pick) {
    setPicked((current) => (current?.kind === next.kind && current.id === next.id ? null : next));
  }

  async function refresh() {
    await Promise.all(
      ["org-people", "org-members", "org-groups", "directory"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  }

  async function submit() {
    setPending(true);
    setError(undefined);
    const res = picked
      ? picked.kind === "group"
        ? await apiClient.v1.org.groups.$post({ json: { groupId: picked.id, role } })
        : await apiClient.v1.org.members.$post({ json: { userId: picked.id, role } })
      : await apiClient.v1.org.invites.$post({ json: { email, role } });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    if (picked) {
      await refresh();
      change(false);
      return;
    }
    setCreated(createdOrgInviteSchema.parse(await res.json()));
    await refresh();
  }

  const roleSelect = (label: string) => (
    <OrgRoleSelect value={role} onChange={setRole} label={label} />
  );

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite link for {created.email}</DialogTitle>
              <DialogDescription>
                Send it to them yourself. Only an account with this email can use it, once, within 7
                days.
              </DialogDescription>
            </DialogHeader>
            <InputGroup>
              <InputGroupInput
                aria-label="Invite link"
                value={created.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <CopyButton label="Copy link" value={created.url} />
              </InputGroupAddon>
            </InputGroup>
            <p className="text-xs text-muted-foreground">Copy it now: it is shown only once.</p>
            <DialogFooter>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (picked || inviting) void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add people</DialogTitle>
              <DialogDescription>
                {anyDirectory
                  ? `Add ${directory.groups ? "people and groups" : "people"} from your directory, or invite someone by their email. Mage sends no emails; you share the link it makes.`
                  : "Invite someone by their email. Mage sends no emails; you share the link it makes."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-2">
              <FieldLabel htmlFor={inputId}>
                {directory.groups ? "Name, email or group" : "Name or email"}
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={inputId}
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setPicked(null);
                  }}
                  placeholder="name@example.com"
                  autoComplete="off"
                />
              </InputGroup>
              <ul aria-label="Suggestions" className="flex flex-col">
                {inviting && (
                  <Suggestion
                    avatar={<MailIcon />}
                    name={
                      <>
                        Invite <span className="font-medium">{email}</span> as
                      </>
                    }
                  >
                    {roleSelect("Role to invite as")}
                  </Suggestion>
                )}
                {groupMatches.map((group) => {
                  const chosen = picked?.kind === "group" && picked.id === group.id;
                  return (
                    <Suggestion
                      key={`group:${group.id}`}
                      avatar={<UsersIcon />}
                      name={group.name}
                      detail={`Directory group · ${plural(group.memberCount, "person", "people")}`}
                      {...(!group.role && {
                        picked: chosen,
                        onPick: () => pick({ kind: "group", id: group.id, name: group.name }),
                      })}
                    >
                      {group.role ? (
                        <Already>Linked as {ORG_ROLE_LABELS[group.role].toLowerCase()}</Already>
                      ) : (
                        chosen && roleSelect(`Role for ${group.name}`)
                      )}
                    </Suggestion>
                  );
                })}
                {fromDirectory.map((person) => {
                  const chosen = picked?.kind === "user" && picked.id === person.userId;
                  return (
                    <Suggestion
                      key={`user:${person.userId}`}
                      avatar={initialsOf(person.name)}
                      name={person.name}
                      detail={person.email}
                      {...(!person.role && {
                        picked: chosen,
                        onPick: () => pick({ kind: "user", id: person.userId, name: person.name }),
                      })}
                    >
                      {person.role ? (
                        <Already>Already a member</Already>
                      ) : (
                        chosen && roleSelect(`Role for ${person.name}`)
                      )}
                    </Suggestion>
                  );
                })}
                {matches.map((person) => (
                  <Suggestion
                    key={person.userId}
                    avatar={initialsOf(person.name)}
                    name={person.name}
                    detail={person.email}
                  >
                    <Already>Already a member</Already>
                  </Suggestion>
                ))}
                {nothing && (
                  <li className="py-1.5 text-sm text-muted-foreground">
                    Nobody here by that name. Type their email to invite them.
                  </li>
                )}
              </ul>
            </div>
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={!(picked || inviting) || pending}>
                {picked ? (picked.kind === "group" ? "Link group" : "Add") : "Invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The linked group a member is in through, and at a glance every one of them when there are more.
function ViaGroups({ person }: { person: Member }) {
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
function GroupMembersPeek({ group }: { group: LinkedGroup }) {
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

export function OrgPeople() {
  const queryClient = useQueryClient();
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
  const [error, setError] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();

  async function refresh() {
    await Promise.all(
      ["org-people", "org-members", "org-groups", "directory"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  }

  async function setRole(userId: string, role: OrgRole) {
    setError(undefined);
    const res = await apiClient.v1.org.members[":userId"].$patch({
      param: { userId },
      json: { role },
    });
    if (!res.ok) setError(await errorOf(res));
    await refresh();
  }

  async function setGroupRole(id: string, role: OrgRole) {
    setError(undefined);
    const res = await apiClient.v1.org.groups[":id"].$patch({ param: { id }, json: { role } });
    if (!res.ok) setError(await errorOf(res));
    await refresh();
  }

  async function remove() {
    if (!removing) return;
    setRemoveError(undefined);
    const res =
      removing.kind === "member"
        ? await apiClient.v1.org.members[":userId"].$delete({
            param: { userId: removing.userId },
          })
        : removing.kind === "group"
          ? await apiClient.v1.org.groups[":id"].$delete({ param: { id: removing.id } })
          : await apiClient.v1.org.invites[":id"].$delete({ param: { id: removing.id } });
    if (!res.ok) {
      setRemoveError(await errorOf(res));
      return;
    }
    setRemoving(null);
    await refresh();
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
      if (person.kind === "group") void setGroupRole(person.id, role);
      if (person.kind === "member") void setRole(person.userId, role);
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
            <FieldError>{error}</FieldError>
          </DataTable>
        </SettingsCard>
      )}
      <AddPeopleDialog open={adding} onOpenChange={setAdding} directory={directory} />
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
            <AlertDialogTitle>{removal?.title}</AlertDialogTitle>
            <AlertDialogDescription>{removal?.description}</AlertDialogDescription>
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
function groupsOf(person: Member) {
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
