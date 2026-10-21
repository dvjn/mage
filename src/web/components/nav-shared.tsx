// The sidebar's "Shared with you" entry, at the foot of its sections whichever space is active: it
// opens the page of threads the signed-in person is a guest in, counts them, and is marked while
// that page or one of those threads is open.

import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/web/components/ui/sidebar";
import { sharedThreadsQuery } from "@/web/lib/queries";

export function NavShared() {
  const shared = useQuery(sharedThreadsQuery);
  const { threadId } = useParams({ strict: false });
  const matchRoute = useMatchRoute();
  const count = shared.data?.length ?? 0;
  const active =
    !!matchRoute({ to: "/shared" }) || !!shared.data?.some((thread) => thread.id === threadId);
  return (
    <SidebarGroup className="mt-auto">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton isActive={active} render={<Link to="/shared" />}>
            <UsersIcon />
            <span>Shared with you</span>
          </SidebarMenuButton>
          {count > 0 && <SidebarMenuBadge>{count}</SidebarMenuBadge>}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
