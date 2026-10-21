// The sidebar's "Shared with you" section: the threads the signed-in person is a guest in, each
// with the space and org it belongs to below its title, whichever of their own spaces is active.
// It is left out while there are none.

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/web/components/ui/sidebar";
import { sharedThreadsQuery } from "@/web/lib/queries";

export function NavShared() {
  const shared = useQuery(sharedThreadsQuery);
  const { threadId } = useParams({ strict: false });
  if (!shared.data?.length) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Shared with you</SidebarGroupLabel>
      <SidebarMenu>
        {shared.data.map((thread) => (
          <SidebarMenuItem key={thread.id}>
            <SidebarMenuButton
              size="lg"
              isActive={thread.id === threadId}
              title={`${thread.title} — ${thread.spaceName}, ${thread.orgName}`}
              render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
            >
              <MessageSquareIcon />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate">{thread.title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {thread.spaceName} · {thread.orgName}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
