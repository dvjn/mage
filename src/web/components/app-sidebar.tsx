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

import { NavThreads, useNewThread } from "@/web/components/nav-threads";
import { NavUser } from "@/web/components/nav-user";
import { SidebarOfflineStatus } from "@/web/components/offline-status";
import { ShortcutHint } from "@/web/components/shortcut-keys";
import { SpaceSwitcher } from "@/web/components/space-switcher";
import { useOpenThreadSearch } from "@/web/components/thread-search";
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
import { useActiveSpace } from "@/web/lib/active-space";
import { meQuery } from "@/web/lib/queries";
import { useShortcut } from "@/web/lib/shortcuts";

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
    enabled: space?.role === "owner" || space?.role === "messager",
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
