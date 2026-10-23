// A team org's people in one table, searched and narrowed on the server with the values in the
// address: for its owners, the invites not yet used first, then its members, with their role, the
// groups they are in when the org has groups, and when they joined. Owners add people, which in
// this local directory means inviting them by email with a link shown once, change roles, remove
// members and revoke invites; nobody changes their own role, and the last owner stays one. A
// personal org has only its person.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  MailIcon,
  MailXIcon,
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
import { groupsPages, memberGroupsPages, membersPages, peoplePages } from "@/web/lib/list-queries";
import { meQuery } from "@/web/lib/queries";
import { LOCK_REASONS } from "@/web/lib/roles";
import { timeUntil } from "@/web/lib/time";

export interface PeopleSearch {
  q?: string;
  role?: OrgRole;
  status?: "member" | "invited";
}

const peopleRoute = getRouteApi("/_app/org/people");

const ROLES: OrgRole[] = ["member", "owner"];
const ROLE_OPTIONS = ROLES.map((value) => ({ value, label: ORG_ROLE_LABELS[value] }));

const STATUS_OPTIONS = [
  { value: "member", label: "Member" },
  { value: "invited", label: "Invited" },
];

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

// Adds people to the org. With no directory to pick from, everyone is added by inviting their
// email: the text searches who is in already, and an email not among them can be invited with a
// role, which makes a link shown once.
function AddPeopleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const [role, setRole] = useState<OrgRole>("member");
  const [created, setCreated] = useState<CreatedOrgInvite>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const found = useInfiniteQuery({ ...membersPages({ q }, 6), enabled: open && !!q });
  const matches = found.data?.pages[0]?.items ?? [];
  const email = text.trim().toLowerCase();
  const isEmail = emailSchema.safeParse(email).success;
  const member = matches.find((person) => person.email.toLowerCase() === email);

  function change(next: boolean) {
    onOpenChange(next);
    if (next) return;
    setText("");
    setCreated(undefined);
    setError(undefined);
    setRole("member");
  }

  async function invite() {
    setPending(true);
    setError(undefined);
    const res = await apiClient.v1.org.invites.$post({ json: { email, role } });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setCreated(createdOrgInviteSchema.parse(await res.json()));
    await queryClient.invalidateQueries({ queryKey: ["org-people"] });
  }

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
              if (isEmail && !member) void invite();
            }}
          >
            <DialogHeader>
              <DialogTitle>Add people</DialogTitle>
              <DialogDescription>
                Invite someone by their email. Mage sends no emails; you share the link it makes.
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-2">
              <FieldLabel htmlFor={inputId}>Name or email</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={inputId}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="name@example.com"
                  autoComplete="off"
                />
              </InputGroup>
              <ul aria-label="Suggestions" className="flex flex-col">
                {isEmail && !member && (
                  <li className="flex min-w-0 flex-wrap items-center gap-2.5 py-1.5">
                    <Avatar size="sm">
                      <AvatarFallback>
                        <MailIcon className="size-3" />
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      Invite <span className="font-medium">{email}</span> as
                    </span>
                    <OrgRoleSelect value={role} onChange={setRole} label="Role to invite as" />
                  </li>
                )}
                {matches.map((person) => (
                  <li key={person.userId} className="flex items-center gap-2.5 py-1.5">
                    <Avatar size="sm">
                      <AvatarFallback className="text-[0.625rem] font-medium">
                        {initialsOf(person.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate text-sm">{person.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{person.email}</span>
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <CheckIcon className="size-3" />
                      Already a member
                    </span>
                  </li>
                ))}
                {q && !isEmail && found.data && matches.length === 0 && (
                  <li className="py-1.5 text-sm text-muted-foreground">
                    Nobody here by that name. Type their email to invite them.
                  </li>
                )}
              </ul>
            </div>
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={!isEmail || !!member || pending}>
                Invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// A member's groups, at a glance.
function GroupsPeek({ person }: { person: Extract<OrgPerson, { kind: "member" }> }) {
  if (person.groupCount === 0) return <>—</>;
  return (
    <Peek label={`Groups of ${person.name}`} trigger={plural(person.groupCount, "group", "groups")}>
      {() => (
        <PeekList
          title={`${person.name}'s groups`}
          query={(q) => memberGroupsPages(person.userId, { q }, 20)}
          rowKey={(group) => group.id}
          row={(group) => (
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate">{group.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {group.memberCount}
              </span>
            </span>
          )}
          empty="In no groups"
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
  // Groups come from a directory; while the org has none, nothing speaks of them.
  const groups = useInfiniteQuery({ ...groupsPages({}, 1), enabled: team });
  const withGroups = (groups.data?.pages[0]?.total ?? 0) > 0;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Extract<OrgPerson, { kind: "member" }> | null>(null);
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
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["org-people"] }),
      queryClient.invalidateQueries({ queryKey: ["org-members"] }),
    ]);
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

  async function revoke(id: string) {
    setError(undefined);
    const res = await apiClient.v1.org.invites[":id"].$delete({ param: { id } });
    if (!res.ok) setError(await errorOf(res));
    await refresh();
  }

  const rows = people.data?.pages.flatMap((page) => page.items) ?? [];
  const columns = [ROLE_COLUMN, ...(withGroups ? [{ label: "Groups" }] : []), { label: "Joined" }];

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
              ...(manages
                ? [
                    {
                      label: "Status",
                      value: search.status,
                      options: STATUS_OPTIONS,
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
                    {withGroups && <ContextCell>—</ContextCell>}
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
                ) : (
                  <MemberRow
                    key={person.userId}
                    person={person}
                    you={person.userId === me.data?.user.id}
                    manages={!!manages}
                    withGroups={withGroups}
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
      <AddPeopleDialog open={adding} onOpenChange={setAdding} />
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
              Remove {removing?.name} from {me.data?.org.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They lose its spaces at once, and their messages still waiting for the agent are
              dropped. What they wrote stays, marked as from a former member. A new invite brings
              them back.
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
    </>
  );
}

function MemberRow({
  person,
  you,
  manages,
  withGroups,
  onRole,
  onRemove,
}: {
  person: Extract<OrgPerson, { kind: "member" }>;
  you: boolean;
  manages: boolean;
  withGroups: boolean;
  onRole: (role: OrgRole) => void;
  onRemove: () => void;
}) {
  const role = {
    value: person.role,
    options: ROLE_OPTIONS,
    ...(manages && { onChange: onRole }),
    ...(manages && person.locked && { locked: LOCK_REASONS.org[person.locked] }),
  };
  return (
    <PeopleRow label={person.name}>
      <SubjectCell
        avatar={{ initials: person.name }}
        name={person.name}
        you={you}
        detail={person.email}
        folded={
          <>
            {ORG_ROLE_LABELS[person.role]}
            {withGroups && person.groupCount > 0 && (
              <>
                {" · "}
                <GroupsPeek person={person} />
              </>
            )}
          </>
        }
      />
      <RoleCell label={`Role of ${person.name}`} choice={role} />
      {withGroups && (
        <ContextCell className="whitespace-nowrap">
          <GroupsPeek person={person} />
        </ContextCell>
      )}
      <ContextCell className="whitespace-nowrap">
        <Time iso={person.joinedAt} />
      </ContextCell>
      <ActionsCell
        label={person.name}
        role={role}
        destructive={
          manages &&
          !you && (
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <UserMinusIcon />
              Remove from organization…
            </DropdownMenuItem>
          )
        }
      />
    </PeopleRow>
  );
}
