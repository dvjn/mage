// The sidebar's header: the active space's initials, name and organisation, with a menu to switch
// to another space or add one.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { spaceSchema } from "@/shared/spaces.ts";
import { NameDialog } from "@/web/components/name-dialog";
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
import { useActiveSpace } from "@/web/lib/active-space";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { initialsOf } from "@/web/lib/initials";
import { meQuery, spacesQuery } from "@/web/lib/queries";

export function SpaceSwitcher() {
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery);
  const spaces = useQuery(spacesQuery);
  const active = useActiveSpace();
  const [adding, setAdding] = useState(false);

  async function create(name: string) {
    const res = await apiClient.v1.spaces.$post({ json: { name } });
    if (!res.ok) return errorOf(res);
    const space = spaceSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spacesQuery.queryKey });
    await navigate({ to: "/s/$spaceId", params: { spaceId: space.id } });
    return undefined;
  }

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
              {initialsOf(active?.name ?? "")}
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{active?.name}</span>
              <span className="truncate text-xs">{me.data?.org.name}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Spaces
              </DropdownMenuLabel>
              {spaces.data?.map((space) => (
                <DropdownMenuItem
                  key={space.id}
                  onClick={() =>
                    void navigate({ to: "/s/$spaceId", params: { spaceId: space.id } })
                  }
                  className="gap-2 p-2"
                >
                  <div className="flex size-6 items-center justify-center rounded-md border text-[0.625rem] font-medium">
                    {initialsOf(space.name)}
                  </div>
                  {space.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem className="gap-2 p-2" onClick={() => setAdding(true)}>
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">Add space</div>
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
