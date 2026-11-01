// The app's sidebar, inset beside the page: whether the app is offline, where the person is (a
// space, with a switcher, or the threads shared with them), the thread search, the space's actions,
// its folders and threads or the shared threads, and the user, with each action's shortcut shown on
// hover or while ⌘ or Ctrl is held. On a phone it closes as soon as a page opens; its shortcut opens
// a new thread in the active space.

import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { useEffect } from "react";

import { meQuery } from "@/web/auth/queries";
import { ShortcutHint } from "@/web/components/shortcut-keys";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { useModHeld } from "@/web/hooks/use-mod-held";
import { useShortcut } from "@/web/lib/shortcuts";
import { NavUser } from "@/web/shell/nav-user";
import { SidebarOfflineStatus } from "@/web/shell/offline-status";
import { useActiveSpace } from "@/web/spaces/active-space";
import { SpaceSwitcher } from "@/web/spaces/space-switcher";
import { NavThreads } from "@/web/threads/nav/nav-threads";
import { useNewThread } from "@/web/threads/nav/use-new-thread";
import { useOpenThreadSearch } from "@/web/threads/thread-search";

function NavSearch() {
  const openSearch = useOpenThreadSearch();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => openSearch()}>
          <SearchIcon />
          <span>Search</span>
          <ShortcutHint id="search" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const me = useQuery(meQuery);
  const { setOpenMobile } = useSidebar();
  const { pathname, searchStr } = useLocation();
  const space = useActiveSpace();
  const newThread = useNewThread();
  const hints = useModHeld();

  useEffect(() => setOpenMobile(false), [pathname, searchStr, setOpenMobile]);

  useShortcut("newThread", () => space && newThread(space.id), {
    enabled: !space?.archived && (space?.role === "owner" || space?.role === "messager"),
  });

  return (
    <Sidebar variant="inset" data-hints={hints ? "shown" : undefined} {...props}>
      <SidebarHeader>
        <SidebarOfflineStatus />
        <SpaceSwitcher />
        <NavSearch />
      </SidebarHeader>
      <SidebarContent>
        <NavThreads />
      </SidebarContent>
      <SidebarFooter>{me.data && <NavUser user={me.data.user} />}</SidebarFooter>
    </Sidebar>
  );
}
