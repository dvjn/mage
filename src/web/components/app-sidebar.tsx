// The app's sidebar, inset beside the page: the active space with a switcher, the space's actions,
// its folders and threads, the threads shared with the signed-in user, and the user.

import { useQuery } from "@tanstack/react-query";
import type * as React from "react";

import { NavShared } from "@/web/components/nav-shared";
import { NavThreads } from "@/web/components/nav-threads";
import { NavUser } from "@/web/components/nav-user";
import { SpaceSwitcher } from "@/web/components/space-switcher";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/web/components/ui/sidebar";
import { meQuery } from "@/web/lib/queries";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const me = useQuery(meQuery);
  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SpaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavThreads />
        <NavShared />
      </SidebarContent>
      <SidebarFooter>{me.data && <NavUser user={me.data.user} />}</SidebarFooter>
    </Sidebar>
  );
}
