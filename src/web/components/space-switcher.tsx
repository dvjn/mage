// The sidebar's header: where the person is. In a space, its initials and name over how its org is
// named to them; in the threads shared with them, "Shared with you" over how many there are. Its
// menu switches to another space, the active one checked: the person's own spaces, then those they
// joined with their role, then the threads shared with them, counted, and making a new space where the
// org lets them; above them the org this tab is in, opening its settings, and below them switching
// to another org and making a new one.

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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
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

export function SpaceSwitcher() {
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const spaces = useQuery(spacesQuery);
  const sharedThreads = useQuery(sharedThreadsQuery);
  const sharedCount = sharedThreads.data?.length ?? 0;
  const place = usePlace();
  const [adding, setAdding] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const orgs = useQuery(orgsQuery);
  const tab = tabOrg();
  const active = place?.kind === "space" ? place.space : undefined;
  const team = me.data?.org.kind === "team";
  const settings = useQuery({ ...teamSettingsQuery, enabled: team });
  const canCreate =
    !team || me.data?.role === "owner" || settings.data?.spaceCreation === "members";
  const yours = spaces.data?.filter((space) => space.role === "owner") ?? [];
  const joined =
    spaces.data?.filter((space) => space.role === "messager" || space.role === "viewer") ?? [];

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
            className="min-w-60 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            {/* The org this tab is in; the row opens its settings. */}
            <DropdownMenuGroup>
              <DropdownMenuItem
                aria-label="Organization settings"
                className="gap-2 p-2"
                render={<Link to="/org/general" />}
              >
                <span className="truncate font-medium">{org}</span>
                <SettingsIcon className="ml-auto text-muted-foreground" aria-hidden />
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Your spaces
              </DropdownMenuLabel>
              {yours.map((space) => (
                <SpaceRow
                  key={space.id}
                  space={space}
                  active={space.id === active?.id}
                  onSelect={() => open(space)}
                />
              ))}
            </DropdownMenuGroup>
            {joined.length > 0 && (
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Joined spaces
                </DropdownMenuLabel>
                {joined.map((space) => (
                  <SpaceRow
                    key={space.id}
                    space={space}
                    active={space.id === active?.id}
                    onSelect={() => open(space)}
                  />
                ))}
              </DropdownMenuGroup>
            )}
            {canCreate && (
              <DropdownMenuGroup>
                <AddRow label="New space" onSelect={() => setAdding(true)} />
              </DropdownMenuGroup>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
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
                <DropdownMenuGroup>
                  {orgs.data.orgs.length <= 1 ? (
                    <AddRow label="New organization" onSelect={() => setCreatingOrg(true)} />
                  ) : isMobile ? (
                    // On a phone a submenu would cover the menu, so the orgs list inline.
                    <>
                      <DropdownMenuLabel className="text-xs text-muted-foreground">
                        Switch organization
                      </DropdownMenuLabel>
                      {orgs.data.orgs.map((one) => (
                        <OrgRow key={one.id} org={one} active={one.id === tab} />
                      ))}
                      {orgs.data.canCreate && (
                        <AddRow label="New organization" onSelect={() => setCreatingOrg(true)} />
                      )}
                    </>
                  ) : (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2 p-2">
                        <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                          <ArrowLeftRightIcon className="size-4" />
                        </div>
                        Switch organization
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-56">
                        {orgs.data.orgs.map((one) => (
                          <OrgRow key={one.id} org={one} active={one.id === tab} />
                        ))}
                        {orgs.data.canCreate && (
                          <>
                            <DropdownMenuSeparator />
                            <AddRow
                              label="New organization"
                              onSelect={() => setCreatingOrg(true)}
                            />
                          </>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
