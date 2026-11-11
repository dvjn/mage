// The sidebar's header: where the person is. In a space, its initials and name over how its org is
// named to them; in the threads shared with them, "Shared with you" over how many there are. Its
// menu switches to another space, the active one checked: the person's own spaces, then those they
// joined with their role, then their own archived space and the trash, when it holds spaces they
// may restore, then the threads shared with them, counted, and making a new space, or their own
// one, where the org lets them; above them the org this tab is in, opening its settings, and below
// them switching to another org and making a new one. A search at the top narrows the spaces as you type, and
// Enter opens the first match; the orgs' submenu has its own. The spaces scroll between the org
// header, which steps aside while searching, and "New space" and what sits below it.

import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  Building2Icon,
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { orgSubtitle } from "@/shared/me.ts";
import { type OrgSummary } from "@/shared/orgs.ts";
import { type SpaceSummary } from "@/shared/spaces.ts";
import { NameDialog } from "@/web/components/name-dialog";
import { useToast } from "@/web/shell/toaster";
import { Badge } from "@/web/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuFilter,
  DropdownMenuGroup,
  DropdownMenuInput,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuList,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  useDropdownMenuFilter,
} from "@/web/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { usePlace } from "@/web/spaces/active-space";
import { initialsOf } from "@/web/lib/initials";
import { lastSpace } from "@/web/spaces/last-space";
import { switchOrg, tabOrg } from "@/web/lib/org-tab";
import { meQuery } from "@/web/auth/queries";
import { sharedThreadsQuery } from "@/web/guests/queries";
import { orgsQuery, teamSettingsQuery } from "@/web/orgs/queries";
import { spacesQuery, spaceTrashQuery } from "@/web/spaces/queries";
import { SpaceTrash } from "@/web/spaces/space-trash";
import { ROLE_LABELS } from "@/web/spaces/roles";
import { useCreateMySpace, useCreateOrg, useCreateSpace } from "@/web/spaces/mutations";

function SpaceRow({
  space,
  active,
  onSelect,
}: {
  space: SpaceSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onSelect} className="gap-2">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-md border text-[0.625rem] font-medium">
        {initialsOf(space.name)}
      </div>
      <span className="truncate">{space.name}</span>
      {space.role && space.role !== "owner" && (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {ROLE_LABELS[space.role]}
        </Badge>
      )}
      {active && (
        <>
          <CheckIcon className="ml-auto" aria-hidden />
          <span className="sr-only">(active)</span>
        </>
      )}
    </DropdownMenuItem>
  );
}

// A personal org is "Personal"; a team org goes by its name.
function orgLabel(org: OrgSummary) {
  return org.kind === "personal" ? "Personal" : org.name;
}

// Opens the org in this tab, at the space used last there.
function openOrg(orgId: string) {
  const space = lastSpace(orgId);
  switchOrg(orgId, space ? `/s/${space}` : "/");
}

function OrgRow({ org, active }: { org: OrgSummary; active: boolean }) {
  return (
    <DropdownMenuItem className="gap-2" onClick={() => !active && openOrg(org.id)}>
      <div className="flex size-6 shrink-0 items-center justify-center rounded-md border text-[0.625rem] font-medium">
        {initialsOf(orgLabel(org))}
      </div>
      <span className="truncate">{orgLabel(org)}</span>
      {active && (
        <>
          <CheckIcon className="ml-auto" aria-hidden />
          <span className="sr-only">(active)</span>
        </>
      )}
    </DropdownMenuItem>
  );
}

// Makes something new at the end of its list.
function AddRow({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <DropdownMenuItem className="gap-2" onClick={onSelect}>
      <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
        <PlusIcon className="size-4" />
      </div>
      <span>{label}</span>
    </DropdownMenuItem>
  );
}

// The orgs to switch to, in a submenu that finds one as you type.
function OrgSubmenu({
  orgs,
  tab,
  canCreate,
  onCreate,
}: {
  orgs: OrgSummary[];
  tab: string | null;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const { contains } = useDropdownMenuFilter();
  const shown = orgs.filter((one) => contains(orgLabel(one), query));
  return (
    <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery} autoHighlight>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
            <ArrowLeftRightIcon className="size-4" />
          </div>
          Switch organization
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="flex min-w-56 flex-col overflow-y-hidden">
          <DropdownMenuInput aria-label="Filter organizations" placeholder="Find an organization" />
          <DropdownMenuList className="max-h-72">
            {shown.map((one) => (
              <OrgRow key={one.id} org={one} active={one.id === tab} />
            ))}
            {shown.length === 0 && <NoMatch>No organization matches.</NoMatch>}
          </DropdownMenuList>
          {canCreate && (
            <>
              <DropdownMenuSeparator />
              <AddRow label="New organization" onSelect={onCreate} />
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuFilter>
  );
}

// Said in a list when nothing matches the search.
function NoMatch({ children }: { children: string }) {
  return (
    <div role="status" className="px-1.5 py-2 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function SpaceSwitcher() {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const toast = useToast();
  const me = useQuery(meQuery);
  const spaces = useQuery(spacesQuery);
  const sharedThreads = useQuery(sharedThreadsQuery);
  const orgs = useQuery(orgsQuery);
  const sharedCount = sharedThreads.data?.length ?? 0;
  const place = usePlace();
  const [adding, setAdding] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const createSpace = useCreateSpace();
  const mine = useCreateMySpace();
  const newOrg = useCreateOrg();
  const tab = tabOrg();
  const active = place?.kind === "space" ? place.space : undefined;
  const team = me.data?.org.kind === "team";
  const settings = useQuery({ ...teamSettingsQuery, enabled: team });
  const trash = useQuery({ ...spaceTrashQuery, enabled: team });
  const [trashOpen, setTrashOpen] = useState(false);
  const canCreate =
    !team || me.data?.role === "owner" || settings.data?.spaceCreation === "members";
  const yours = spaces.data?.filter((space) => space.role === "owner" && !space.archived) ?? [];
  const joined =
    spaces.data?.filter((space) => space.role === "messager" || space.role === "viewer") ?? [];
  const archived = spaces.data?.filter((space) => space.archived) ?? [];
  // A team org's member may make a space of their own once, while the org allows it.
  const canCreateMine =
    team &&
    !!settings.data?.memberSpaces &&
    !!spaces.data &&
    !spaces.data.some((space) => space.kind === "personal" && space.role === "owner");
  const [query, setQuery] = useState("");
  const { contains } = useDropdownMenuFilter();
  const shownYours = yours.filter((space) => contains(space.name, query));
  const shownJoined = joined.filter((space) => contains(space.name, query));
  const shownArchived = archived.filter((space) => contains(space.name, query));
  const orgsInline = isMobile && (orgs.data?.orgs.length ?? 0) > 1;
  const shownOrgs = orgsInline
    ? (orgs.data?.orgs ?? []).filter((one) => contains(orgLabel(one), query))
    : [];
  const nothing =
    query.trim() !== "" &&
    shownYours.length + shownJoined.length + shownArchived.length + shownOrgs.length === 0;

  function create(name: string) {
    return createSpace.mutateAsync(name).then(
      (space) =>
        navigate({ to: "/s/$spaceId", params: { spaceId: space.id } }).then(() => undefined),
      (failed: Error) => failed.message,
    );
  }

  function createMine() {
    mine.mutate(undefined, {
      onSuccess: (space) => navigate({ to: "/s/$spaceId", params: { spaceId: space.id } }),
      onError: (failed) => toast(failed.message),
    });
  }

  function createOrg(name: string) {
    return newOrg.mutateAsync(name).then(
      (orgId) => {
        switchOrg(orgId, "/org/general");
        return undefined;
      },
      (failed: Error) => failed.message,
    );
  }

  function open(space: SpaceSummary) {
    void navigate({
      to: space.role ? "/s/$spaceId" : "/s/$spaceId/settings",
      params: { spaceId: space.id },
    });
  }

  const org = me.data && orgSubtitle(me.data);
  const shared = place?.kind === "shared";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery} autoHighlight>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                  aria-label="Switch space"
                />
              }
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-medium text-sidebar-primary-foreground">
                {shared ? <UsersIcon className="size-4" /> : initialsOf(active?.name ?? "")}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {shared ? "Shared with you" : active?.name}
                </span>
                <span className="truncate text-xs">
                  {shared ? `${sharedCount} ${sharedCount === 1 ? "thread" : "threads"}` : org}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="flex min-w-60 flex-col overflow-y-hidden rounded-lg"
              align="start"
              side={isMobile ? "bottom" : "right"}
              sideOffset={4}
            >
              <DropdownMenuInput
                aria-label={orgsInline ? "Filter spaces and organizations" : "Filter spaces"}
                placeholder={orgsInline ? "Find a space or organization" : "Find a space"}
              />
              {/* The org this tab is in; the row opens its settings. While a search is typed it
                  steps aside, so the first match is the one Enter opens. */}
              {query.trim() === "" && (
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    aria-label="Organization settings"
                    className="gap-2"
                    render={<Link to="/org/general" />}
                  >
                    <div className="flex size-6 shrink-0 items-center justify-center rounded-md border">
                      <Building2Icon className="size-4" />
                    </div>
                    <span className="truncate">{org}</span>
                    <SettingsIcon className="ml-auto" aria-hidden />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </DropdownMenuGroup>
              )}
              <DropdownMenuList className="max-h-72">
                {shownYours.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Your spaces
                    </DropdownMenuLabel>
                    {shownYours.map((space) => (
                      <SpaceRow
                        key={space.id}
                        space={space}
                        active={space.id === active?.id}
                        onSelect={() => open(space)}
                      />
                    ))}
                  </DropdownMenuGroup>
                )}
                {shownJoined.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Joined spaces
                    </DropdownMenuLabel>
                    {shownJoined.map((space) => (
                      <SpaceRow
                        key={space.id}
                        space={space}
                        active={space.id === active?.id}
                        onSelect={() => open(space)}
                      />
                    ))}
                  </DropdownMenuGroup>
                )}
                {shownArchived.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Archived
                    </DropdownMenuLabel>
                    {shownArchived.map((space) => (
                      <SpaceRow
                        key={space.id}
                        space={space}
                        active={space.id === active?.id}
                        onSelect={() => open(space)}
                      />
                    ))}
                  </DropdownMenuGroup>
                )}
                {query.trim() === "" && !!trash.data?.length && (
                  <DropdownMenuItem className="gap-2" onClick={() => setTrashOpen(true)}>
                    <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                      <Trash2Icon className="size-4" />
                    </div>
                    <span>Trash</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {trash.data.length}
                    </span>
                  </DropdownMenuItem>
                )}
                {/* On a phone a submenu would cover the menu, so the orgs list inline. */}
                {orgsInline && shownOrgs.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Switch organization
                    </DropdownMenuLabel>
                    {shownOrgs.map((one) => (
                      <OrgRow key={one.id} org={one} active={one.id === tab} />
                    ))}
                  </DropdownMenuGroup>
                )}
                {nothing && (
                  <NoMatch>
                    {orgsInline ? "No space or organization matches." : "No space matches."}
                  </NoMatch>
                )}
              </DropdownMenuList>
              {(canCreate || canCreateMine) && (
                <DropdownMenuGroup className="shrink-0">
                  <DropdownMenuSeparator />
                  {canCreate && <AddRow label="New space" onSelect={() => setAdding(true)} />}
                  {canCreateMine && <AddRow label="Create my space" onSelect={createMine} />}
                </DropdownMenuGroup>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuGroup className="shrink-0">
                <DropdownMenuItem
                  className="gap-2"
                  onClick={() => void navigate({ to: "/shared" })}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                    <UsersIcon className="size-4" />
                  </div>
                  <span>Shared with you</span>
                  {sharedCount > 0 && (
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {sharedCount}
                    </span>
                  )}
                  {shared && (
                    <>
                      <CheckIcon className={sharedCount > 0 ? undefined : "ml-auto"} aria-hidden />
                      <span className="sr-only">(active)</span>
                    </>
                  )}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              {orgs.data && (orgs.data.orgs.length > 1 || orgs.data.canCreate) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup className="shrink-0">
                    {orgs.data.orgs.length <= 1 || orgsInline ? (
                      orgs.data.canCreate && (
                        <AddRow label="New organization" onSelect={() => setCreatingOrg(true)} />
                      )
                    ) : (
                      <OrgSubmenu
                        orgs={orgs.data.orgs}
                        tab={tab}
                        canCreate={orgs.data.canCreate}
                        onCreate={() => setCreatingOrg(true)}
                      />
                    )}
                  </DropdownMenuGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </DropdownMenuFilter>
        <NameDialog
          title="New organization"
          action="Create"
          label="Organization name"
          open={creatingOrg}
          onOpenChange={setCreatingOrg}
          onSubmit={createOrg}
        />
        <SpaceTrash open={trashOpen} onOpenChange={setTrashOpen} />
        <NameDialog
          title="New space"
          action="Create"
          open={adding}
          onOpenChange={setAdding}
          onSubmit={create}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
