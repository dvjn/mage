// The sidebar's header: where the person is. In a space, its initials and name over how its org is
// named to them; in the threads shared with them, "Shared with you" over how many there are. Its
// menu switches to another space, the active one checked: the person's own spaces, then those they
// joined with their role, then the threads shared with them, counted, and making a new space where the
// org lets them; above them the org this tab is in, opening its settings, and below them switching
// to another org and making a new one. A search at the top narrows the spaces as you type, and
// Enter opens the first match; the orgs' submenu has its own. The spaces scroll between the org
// header, which steps aside while searching, and "New space" and what sits below it.

import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { orgSubtitle } from "@/shared/me.ts";
import { createdOrgSchema, type OrgSummary } from "@/shared/orgs.ts";
import { type SpaceSummary, spaceSchema } from "@/shared/spaces.ts";
import { NameDialog } from "@/web/components/name-dialog";
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
import { usePlace } from "@/web/lib/active-space";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { initialsOf } from "@/web/lib/initials";
import { lastSpace } from "@/web/lib/last-space";
import { switchOrg, tabOrg } from "@/web/lib/org-tab";
import {
  meQuery,
  orgsQuery,
  sharedThreadsQuery,
  spacesQuery,
  teamSettingsQuery,
} from "@/web/lib/queries";
import { ROLE_LABELS } from "@/web/lib/roles";

function SpaceRow({
  space,
  active,
  onSelect,
  muted,
}: {
  space: SpaceSummary;
  active: boolean;
  onSelect: () => void;
  // A space the person manages but is not in.
  muted?: boolean;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      className={cn("gap-2 p-2", muted && "text-muted-foreground")}
    >
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
    <DropdownMenuItem className="gap-2 p-2" onClick={() => !active && openOrg(org.id)}>
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

// Makes something new at the end of its list, muted beside what is there.
function AddRow({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <DropdownMenuItem className="gap-2 p-2" onClick={onSelect}>
      <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
        <PlusIcon className="size-4" />
      </div>
      <div className="font-medium text-muted-foreground">{label}</div>
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
        <DropdownMenuSubTrigger className="gap-2 p-2">
          <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
            <ArrowLeftRightIcon className="size-4" />
          </div>
          Switch organization
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="flex min-w-56 flex-col overflow-y-hidden">
          <DropdownMenuInput aria-label="Filter organizations" placeholder="Find an organization" />
          <DropdownMenuList className="max-h-72 pt-1">
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const spaces = useQuery(spacesQuery);
  const sharedThreads = useQuery(sharedThreadsQuery);
  const orgs = useQuery(orgsQuery);
  const sharedCount = sharedThreads.data?.length ?? 0;
  const place = usePlace();
  const [adding, setAdding] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const tab = tabOrg();
  const active = place?.kind === "space" ? place.space : undefined;
  const team = me.data?.org.kind === "team";
  const settings = useQuery({ ...teamSettingsQuery, enabled: team });
  const canCreate =
    !team || me.data?.role === "owner" || settings.data?.spaceCreation === "members";
  const yours = spaces.data?.filter((space) => space.role === "owner") ?? [];
  const joined =
    spaces.data?.filter((space) => space.role === "messager" || space.role === "viewer") ?? [];
  const [query, setQuery] = useState("");
  const { contains } = useDropdownMenuFilter();
  const shownYours = yours.filter((space) => contains(space.name, query));
  const shownJoined = joined.filter((space) => contains(space.name, query));
  const orgsInline = isMobile && (orgs.data?.orgs.length ?? 0) > 1;
  const shownOrgs = orgsInline
    ? (orgs.data?.orgs ?? []).filter((one) => contains(orgLabel(one), query))
    : [];
  const nothing =
    query.trim() !== "" && shownYours.length + shownJoined.length + shownOrgs.length === 0;

  async function create(name: string) {
    const res = await apiClient.v1.spaces.$post({ json: { name } });
    if (!res.ok) return errorOf(res);
    const space = spaceSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
    await navigate({ to: "/s/$spaceId", params: { spaceId: space.id } });
    return undefined;
  }

  async function createOrg(name: string) {
    const res = await apiClient.v1.orgs.$post({ json: { name } });
    if (!res.ok) return errorOf(res);
    const { orgId } = createdOrgSchema.parse(await res.json());
    switchOrg(orgId, "/org/general");
    return undefined;
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
                <DropdownMenuGroup className="pt-1">
                  <DropdownMenuItem
                    aria-label="Organization settings"
                    className="gap-2 p-2"
                    render={<Link to="/org/general" />}
                  >
                    <span className="truncate font-medium">{org}</span>
                    <SettingsIcon className="ml-auto text-muted-foreground" aria-hidden />
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
              {canCreate && (
                <DropdownMenuGroup className="shrink-0">
                  <DropdownMenuSeparator />
                  <AddRow label="New space" onSelect={() => setAdding(true)} />
                </DropdownMenuGroup>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuGroup className="shrink-0">
                <DropdownMenuItem
                  className="gap-2 p-2"
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
