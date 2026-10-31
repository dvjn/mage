// What a sidebar list shows while it is read, or when it is empty.

import { type ReactNode } from "react";

import { SidebarMenuItem, SidebarMenuSkeleton } from "@/web/components/ui/sidebar";

// Rows of a list still being read, as tall as the rows to come.
export function MenuSkeleton() {
  return [0, 1, 2].map((index) => (
    <SidebarMenuItem key={index}>
      <SidebarMenuSkeleton />
    </SidebarMenuItem>
  ));
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <SidebarMenuItem className="px-2 py-1.5 text-sm text-muted-foreground">
      {children}
    </SidebarMenuItem>
  );
}
