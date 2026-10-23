// The signed-in app: the sidebar beside the current page, open or collapsed as it was last left,
// the thread search and the keyboard shortcuts dialog over both, the header each page starts with, and the one column width every
// page's content sits in.

import { Link, Outlet } from "@tanstack/react-router";
import { Fragment } from "react";

import { AppSidebar } from "@/web/components/app-sidebar";
import { ShortcutsHelpProvider } from "@/web/components/shortcuts-help";
import { ThreadSearchProvider } from "@/web/components/thread-search";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/web/components/ui/breadcrumb";
import { Separator } from "@/web/components/ui/separator";
import { Kbd } from "@/web/components/ui/kbd";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/web/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { shortcutHint } from "@/web/lib/shortcuts";

// The sidebar records whether it is open in this cookie each time it is toggled.
function sidebarWasOpen() {
  return !document.cookie.split("; ").includes("sidebar_state=false");
}

export function AppShell() {
  return (
    <ShortcutsHelpProvider>
      <ThreadSearchProvider>
        {/* The shell fills the window; each page scrolls inside the inset rather than the window. */}
        <SidebarProvider defaultOpen={sidebarWasOpen()} className="h-svh">
          <AppSidebar />
          <SidebarInset className="min-h-0 overflow-y-auto">
            <Outlet />
          </SidebarInset>
        </SidebarProvider>
      </ThreadSearchProvider>
    </ShortcutsHelpProvider>
  );
}

export const pageWidth = "mx-auto w-full max-w-3xl";

export interface Crumb {
  label: string;
  // Where the crumb leads; the last crumb is the current page, and one before it without a link is
  // only a name.
  link?: { to: "/s/$spaceId"; params: { spaceId: string } };
  // Shown in place of the label, on a phone too, as a menu to change what the crumb names.
  control?: React.ReactNode;
  // Sits beside the next crumb with no separator between them.
  joined?: boolean;
}

export function PageHeader({ crumbs, children }: { crumbs: Crumb[]; children?: React.ReactNode }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        {/* Hides and shows the sidebar; on a phone it opens the sidebar as a sheet. */}
        <Tooltip>
          <TooltipTrigger render={<SidebarTrigger className="-ml-1" />} />
          <TooltipContent>
            Toggle sidebar <Kbd>{shortcutHint("toggleSidebar")}</Kbd>
          </TooltipContent>
        </Tooltip>
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-auto"
        />
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              <Fragment key={index}>
                {index > 0 && !crumbs[index - 1]?.joined && (
                  <BreadcrumbSeparator className="hidden md:block" />
                )}
                {crumb.control ? (
                  <BreadcrumbItem className="min-w-0">{crumb.control}</BreadcrumbItem>
                ) : crumb.link ? (
                  <BreadcrumbItem className="hidden md:block">
                    <BreadcrumbLink render={<Link {...crumb.link} />}>{crumb.label}</BreadcrumbLink>
                  </BreadcrumbItem>
                ) : index < crumbs.length - 1 ? (
                  <BreadcrumbItem className="hidden md:block">{crumb.label}</BreadcrumbItem>
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
