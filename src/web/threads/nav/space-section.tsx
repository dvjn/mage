// The sidebar's space section: starts a thread, opens the artifacts gallery and the space's
// settings, as the server lets the person.

import { Link, useMatchRoute } from "@tanstack/react-router";
import { ShapesIcon, PlusIcon, Settings2Icon } from "lucide-react";

import type { SpaceSummary } from "@/shared/spaces.ts";
import { ShortcutHint } from "@/web/components/shortcut-keys";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/web/components/ui/sidebar";
import { useNewThread } from "@/web/threads/nav/use-new-thread";

export function SpaceSection({ space }: { space: SpaceSummary }) {
  const matchRoute = useMatchRoute();
  const newThread = useNewThread();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Space</SidebarGroupLabel>
      <SidebarMenu>
        {space.post && (
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!!matchRoute({ to: "/s/$spaceId/new", params: { spaceId: space.id } })}
              onClick={() => newThread(space.id)}
            >
              <PlusIcon />
              <span>New thread</span>
              <ShortcutHint id="newThread" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={!!matchRoute({ to: "/artifacts", fuzzy: true })}
            render={<Link to="/artifacts" />}
          >
            <ShapesIcon />
            <span>Artifacts</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {space.manage && (
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={
                !!matchRoute({
                  to: "/s/$spaceId/settings",
                  params: { spaceId: space.id },
                  fuzzy: true,
                })
              }
              render={<Link to="/s/$spaceId/settings" params={{ spaceId: space.id }} />}
            >
              <Settings2Icon />
              <span>Space settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
