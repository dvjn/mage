// The sidebar's space section: starts a thread or a folder and opens the space's settings, as the
// person's role allows.

import { Link, useMatchRoute } from "@tanstack/react-router";
import { FolderPlusIcon, PlusIcon, Settings2Icon } from "lucide-react";

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

export function SpaceSection({
  space,
  onNewFolder,
}: {
  space: SpaceSummary;
  onNewFolder: () => void;
}) {
  const matchRoute = useMatchRoute();
  const newThread = useNewThread();
  const writer = space.role === "owner" || space.role === "messager";
  // A viewer has nothing to do here.
  if (!writer && !space.manage) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Space</SidebarGroupLabel>
      <SidebarMenu>
        {writer && (
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
        {writer && (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNewFolder}>
              <FolderPlusIcon />
              <span>New folder</span>
              <ShortcutHint id="newFolder" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
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
