// The sidebar's header: where the person is. In a space, its initials and name over how its org is
// named to them; in the threads shared with them, "Shared with you" over how many there are. Its menu switches to another space, the active one checked: the
// person's own spaces, then those they joined with their role, then the threads shared with
// them, counted, and making a new space.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { orgSubtitle } from "@/shared/me.ts";
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
import { meQuery, sharedThreadsQuery, spacesQuery } from "@/web/lib/queries";
import { ROLE_LABELS } from "@/web/lib/roles";

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
    <DropdownMenuItem onClick={onSelect} className="gap-2 p-2">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-md border text-[0.625rem] font-medium">
        {initialsOf(space.name)}
      </div>
      <span className="truncate">{space.name}</span>
      {space.role !== "owner" && (
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
  const active = place?.kind === "space" ? place.space : undefined;
  const yours = spaces.data?.filter((space) => space.role === "owner") ?? [];
  const joined = spaces.data?.filter((space) => space.role !== "owner") ?? [];

  async function create(name: string) {
    const res = await apiClient.v1.spaces.$post({ json: { name } });
    if (!res.ok) return errorOf(res);
    const space = spaceSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
    await navigate({ to: "/s/$spaceId", params: { spaceId: space.id } });
    return undefined;
  }

  function open(space: SpaceSummary) {
    void navigate({ to: "/s/$spaceId", params: { spaceId: space.id } });
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
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem className="gap-2 p-2" onClick={() => setAdding(true)}>
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">New space…</div>
              </DropdownMenuItem>
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
          </DropdownMenuContent>
        </DropdownMenu>
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
