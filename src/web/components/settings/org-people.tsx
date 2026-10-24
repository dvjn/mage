// A team org's people in one table, searched and narrowed on the server with the values in the
// address: for its owners, the invites not yet used first, then its linked directory groups, then
// its members, with their role, the group they are in through when they are, and when they joined.
// Owners add people from the directory or invite them by email with a link shown once, link the
// directory's groups with a role, change roles, remove members and revoke invites; nobody changes
// their own role, and the last owner in their own right stays one. Someone in only through a group
// leaves when the group is unlinked or the directory takes them out of it. A personal org has only
// its person.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  MailIcon,
  MailXIcon,
  UnlinkIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useId, useState } from "react";
import * as z from "zod";

import {
  type CreatedOrgInvite,
  createdOrgInviteSchema,
  ORG_ROLE_LABELS,
  type OrgPerson,
  type OrgRole,
} from "@/shared/orgs.ts";
import { cn } from "cn";
import { CopyButton } from "@/web/components/copy-button";
import { EmptyState, ListSkeleton, LoadError } from "@/web/components/page-states";
import { Peek, PeekList } from "@/web/components/peek";
import {
  ActionsCell,
  ContextCell,
  HeaderAction,
  LoadMore,
  PeopleRow,
  PeopleTable,
  ROLE_COLUMN,
  RoleCell,
  SubjectCell,
} from "@/web/components/people-table";
import { SettingsTitle } from "@/web/components/settings/layout";
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
import { useDebounced } from "@/web/hooks/use-debounced";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { initialsOf } from "@/web/lib/initials";
import {
  directoryGroupsPages,
  directoryPeoplePages,
  groupMembersPages,
  groupsPages,
  memberGroupsPages,
  membersPages,
  peoplePages,
} from "@/web/lib/list-queries";
import { meQuery } from "@/web/lib/queries";
import { LOCK_REASONS } from "@/web/lib/roles";
import { timeUntil } from "@/web/lib/time";

export interface PeopleSearch {
  q?: string;
  role?: OrgRole;
  status?: "member" | "invited" | "group";
}

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
      <Peek
        label={`Groups of ${person.name}`}
        trigger={`${person.viaGroup} and ${plural(person.groupCount - 1, "other", "others")}`}
      >
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
  const navigate = useNavigate();
  const search = peopleRoute.useSearch();
  const me = useQuery(meQuery);
  const team = me.data?.org.kind === "team";
  const manages = team && me.data?.role === "owner";
  const people = useInfiniteQuery({
    ...peoplePages({
      q: search.q,
      ...(search.role && { role: search.role }),
      ...(search.status && { status: search.status }),
    }),
    enabled: team,
  });
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
  const [removing, setRemoving] = useState<Member | null>(null);
  const [unlinking, setUnlinking] = useState<LinkedGroup | null>(null);
  const [error, setError] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();

  function set(changes: Partial<PeopleSearch>) {
    const next: PeopleSearch = { ...search, ...changes };
    void navigate({
      to: "/org/people",
      search: {
        ...(next.q && { q: next.q }),
        ...(next.role && { role: next.role }),
        ...(next.status && { status: next.status }),
      },
      replace: true,
    });
  }
  const [text, setText] = useSearchText(search.q ?? "", (q) => set({ q }));
  const filtered = !!(search.q || search.role || search.status);
  const clear = () => set({ q: undefined, role: undefined, status: undefined });

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
    const res = await apiClient.v1.org.members[":userId"].$delete({
      param: { userId: removing.userId },
    });
    if (!res.ok) {
      setRemoveError(await errorOf(res));
      return;
    }
    setRemoving(null);
    await refresh();
  }

  async function unlink() {
    if (!unlinking) return;
    setRemoveError(undefined);
    const res = await apiClient.v1.org.groups[":id"].$delete({ param: { id: unlinking.id } });
    if (!res.ok) {
      setRemoveError(await errorOf(res));
      return;
    }
    setUnlinking(null);
    await refresh();
  }

  async function revoke(id: string) {
    setError(undefined);
    const res = await apiClient.v1.org.invites[":id"].$delete({ param: { id } });
    if (!res.ok) setError(await errorOf(res));
    await refresh();
  }

  const rows = people.data?.pages.flatMap((page) => page.items) ?? [];
  const columns = [ROLE_COLUMN, { label: "Joined" }];
  // Removing someone who is also in through a group only takes back their own role.
  const keeps = removing?.viaGroup;

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
        <>
          <TableToolbar
            search={{ label: "Search people", value: text, onChange: setText }}
            filters={[
              {
                label: "Role",
                value: search.role,
                options: ROLE_OPTIONS,
                onChange: (role) => set({ role: role as OrgRole | undefined }),
              },
              ...(manages || withGroups
                ? [
                    {
                      label: "Status",
                      value: search.status,
                      options: [
                        STATUS_OPTIONS[0]!,
                        ...(manages ? [STATUS_OPTIONS[1]!] : []),
                        ...(withGroups ? [GROUP_STATUS] : []),
                      ],
                      onChange: (status: string | undefined) =>
                        set({ status: status as PeopleSearch["status"] }),
                    },
                  ]
                : []),
            ]}
            total={people.data?.pages[0]?.total}
            onReset={clear}
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
          {people.error ? (
            <LoadError />
          ) : !people.data ? (
            <ListSkeleton />
          ) : (
            <PeopleTable
              label="People"
              columns={columns}
              count={rows.length}
              empty={{ icon: <UsersIcon />, title: "Nobody is here yet" }}
              {...(filtered && { filtered: { onClear: clear } })}
            >
              {rows.map((person) =>
                person.kind === "invite" ? (
                  <PeopleRow key={person.id} label={person.email}>
                    <SubjectCell
                      avatar={{ icon: <MailIcon /> }}
                      name={person.email}
                      detail={`${person.createdByName ? `Invited by ${person.createdByName} · ` : "Invited · "}expires ${timeUntil(person.expiresAt) ?? "now"}`}
                      folded={ORG_ROLE_LABELS[person.role]}
                    />
                    <RoleCell
                      label={`Role of ${person.email}`}
                      choice={{ value: person.role, options: ROLE_OPTIONS }}
                    />
                    <ContextCell>—</ContextCell>
                    <ActionsCell
                      label={person.email}
                      destructive={
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => void revoke(person.id)}
                        >
                          <MailXIcon />
                          Revoke invite
                        </DropdownMenuItem>
                      }
                    />
                  </PeopleRow>
                ) : person.kind === "group" ? (
                  <GroupRow
                    key={person.id}
                    group={person}
                    manages={!!manages}
                    onRole={(role) => void setGroupRole(person.id, role)}
                    onUnlink={() => setUnlinking(person)}
                  />
                ) : (
                  <MemberRow
                    key={person.userId}
                    person={person}
                    you={person.userId === me.data?.user.id}
                    manages={!!manages}
                    onRole={(role) => void setRole(person.userId, role)}
                    onRemove={() => setRemoving(person)}
                  />
                ),
              )}
            </PeopleTable>
          )}
          <LoadMore
            more={!!people.hasNextPage}
            loading={people.isFetchingNextPage}
            onLoad={() => void people.fetchNextPage()}
          />
        </>
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
            <AlertDialogTitle>
              {keeps
                ? `Take back ${removing?.name}'s own role?`
                : `Remove ${removing?.name} from ${me.data?.org.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {keeps
                ? `They stay in ${me.data?.org.name} through ${keeps}, with the role it gives.`
                : "They lose its spaces at once, and their messages still waiting for the agent are dropped. What they wrote stays, marked as from a former member. A new invite brings them back."}
            </AlertDialogDescription>
            <FieldError>{removeError}</FieldError>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              {keeps ? "Take back role" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!unlinking}
        onOpenChange={(open) => {
          if (open) return;
          setUnlinking(null);
          setRemoveError(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unlink {unlinking?.name} from {me.data?.org.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its people leave at once, unless they have a role of their own or another linked
              group; the roles its spaces gave the group go too. What they wrote stays, marked as
              from former members. Linking it again brings them back.
            </AlertDialogDescription>
            <FieldError>{removeError}</FieldError>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void unlink()}>
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function GroupRow({
  group,
  manages,
  onRole,
  onUnlink,
}: {
  group: LinkedGroup;
  manages: boolean;
  onRole: (role: OrgRole) => void;
  onUnlink: () => void;
}) {
  const role = { value: group.role, options: ROLE_OPTIONS, ...(manages && { onChange: onRole }) };
  return (
    <PeopleRow label={group.name}>
      <SubjectCell
        avatar={{ icon: <UsersIcon /> }}
        name={
          <>
            {group.name}{" "}
            <Badge variant="secondary" className="ml-1 rounded-sm px-1 align-middle font-normal">
              Directory
            </Badge>
          </>
        }
        detail={<GroupMembersPeek group={group} />}
        folded={ORG_ROLE_LABELS[group.role]}
      />
      <RoleCell label={`Role of ${group.name}`} choice={role} />
      <ContextCell className="whitespace-nowrap">
        <Time iso={group.linkedAt} />
      </ContextCell>
      <ActionsCell
        label={group.name}
        role={role}
        destructive={
          manages && (
            <DropdownMenuItem variant="destructive" onClick={onUnlink}>
              <UnlinkIcon />
              Unlink group…
            </DropdownMenuItem>
          )
        }
      />
    </PeopleRow>
  );
}

function MemberRow({
  person,
  you,
  manages,
  onRole,
  onRemove,
}: {
  person: Member;
  you: boolean;
  manages: boolean;
  onRole: (role: OrgRole) => void;
  onRemove: () => void;
}) {
  const role = {
    value: person.role,
    options: ROLE_OPTIONS,
    ...(manages && { onChange: onRole }),
    ...(manages && person.locked && { locked: LOCK_REASONS.org[person.locked] }),
  };
  const remove = !person.directRole ? (
    // In only through a group: the directory, or unlinking the group, takes them out.
    <DropdownMenuItem disabled className="flex-col items-start gap-0.5">
      <span className="flex items-center gap-2">
        <UserMinusIcon />
        Remove from organization
      </span>
      <span className="text-xs text-muted-foreground">
        In through {person.viaGroup}. Unlink the group or change it in your directory.
      </span>
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem variant="destructive" onClick={onRemove}>
      <UserMinusIcon />
      {person.viaGroup ? "Take back own role…" : "Remove from organization…"}
    </DropdownMenuItem>
  );
  return (
    <PeopleRow label={person.name}>
      <SubjectCell
        avatar={{ initials: person.name }}
        name={person.name}
        you={you}
        detail={person.email}
        note={person.viaGroup && <ViaGroups person={person} />}
        folded={ORG_ROLE_LABELS[person.role]}
      />
      <RoleCell label={`Role of ${person.name}`} choice={role} />
      <ContextCell className="whitespace-nowrap">
        <Time iso={person.joinedAt} />
      </ContextCell>
      <ActionsCell label={person.name} role={role} destructive={manages && !you && remove} />
    </PeopleRow>
  );
}
