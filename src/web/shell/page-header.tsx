// The header each page starts with: the sidebar's toggle, where the page is, and its own actions,
// with the app's offline status while the sidebar is out of sight; and the one column width every
// page's content sits in.

import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { Fragment } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/web/components/ui/breadcrumb";
import { Kbd } from "@/web/components/ui/kbd";
import { Separator } from "@/web/components/ui/separator";
import { SidebarTrigger } from "@/web/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { shortcutHint } from "@/web/lib/shortcuts";
import { HeaderOfflineStatus } from "@/web/shell/offline-status";

export const pageWidth = "mx-auto w-full max-w-3xl";

export interface Crumb {
  label: string;
  // Where the crumb leads; the last crumb is the current page, and one before it without a link is
  // only a name.
  link?: { to: "/s/$spaceId"; params: { spaceId: string } };
  // Shown in place of the label, on a phone too, as a menu to change what the crumb names.
  control?: React.ReactNode;
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
                {index > 0 && <BreadcrumbSeparator className="hidden md:block" />}
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
        <div className="ml-auto flex items-center gap-2">
          <HeaderOfflineStatus />
          {children}
        </div>
      </div>
    </header>
  );
}
