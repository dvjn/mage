// The sidebar's space and threads sections: starting a thread in the active space, then that
// space's threads.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";

import { threadSchema } from "@/shared/threads.ts";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/web/components/ui/sidebar";
import { useActiveSpace } from "@/web/lib/active-space";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { spaceThreadsQuery } from "@/web/lib/queries";

// Makes an empty thread in the space and opens it.
export function useNewThread() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (spaceId: string, text?: string) => {
    const res = await apiClient.v1.spaces[":id"].threads.$post({
      param: { id: spaceId },
      json: text ? { text } : {},
    });
    if (!res.ok) return errorOf(res);
    const thread = threadSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: spaceThreadsQuery(spaceId).queryKey });
    await navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
    return undefined;
  };
}

export function NavThreads() {
  const space = useActiveSpace();
  const threads = useQuery({ ...spaceThreadsQuery(space?.id ?? ""), enabled: !!space });
  const { threadId } = useParams({ strict: false });
  const newThread = useNewThread();

  if (!space) return null;
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Space</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => void newThread(space.id)}>
              <PlusIcon />
              <span>New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarMenu>
          {threads.data?.map((thread) => (
            <SidebarMenuItem key={thread.id}>
              <SidebarMenuButton
                isActive={thread.id === threadId}
                render={<Link to="/t/$threadId" params={{ threadId: thread.id }} />}
              >
                <span>{thread.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
