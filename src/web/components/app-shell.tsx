// The signed-in app: the sidebar beside the current page, open or collapsed as it was last left,
// the header each page starts with, and the one column width every page's content sits in.

import { Link, Outlet } from "@tanstack/react-router";
import { Fragment } from "react";

import { AppSidebar } from "@/web/components/app-sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/web/components/ui/breadcrumb";
import { Separator } from "@/web/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/web/components/ui/sidebar";

// The sidebar records whether it is open in this cookie each time it is toggled.
function sidebarWasOpen() {
  return !document.cookie.split("; ").includes("sidebar_state=false");
}

export function AppShell() {
  return (
    <SidebarProvider defaultOpen={sidebarWasOpen()}>
      <AppSidebar />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

export const pageWidth = "mx-auto w-full max-w-2xl";

export interface Crumb {
  label: string;
  // Where the crumb leads; the last crumb is the current page.
  link?: { to: "/s/$spaceId"; params: { spaceId: string } };
}

export function PageHeader({ crumbs, children }: { crumbs: Crumb[]; children?: React.ReactNode }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        {/* Hides and shows the sidebar; on a phone it opens the sidebar as a sheet. */}
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-auto"
        />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <Fragment key={index}>
                {index > 0 && <BreadcrumbSeparator className="hidden md:block" />}
                {crumb.link ? (
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbLink render={<Link {...crumb.link} />}>{crumb.label}</BreadcrumbLink>
                  </BreadcrumbItem>
                ) : (
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                )}
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
    </header>
  );
}
