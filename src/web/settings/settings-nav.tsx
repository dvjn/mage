// The list of a settings area's pages, beside the page open: left of the page's column on a wide
// screen and as tabs above it otherwise, so the column lines up with every other settings page.

import { cn } from "cn";
import type * as React from "react";

import { PageHeader, type Crumb, pageWidth } from "@/web/app/app-shell";

// The look of one page's link; the open one is marked by the router's active status.
export const settingsNavLink = cn(
  "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
  "data-[status=active]:bg-muted data-[status=active]:font-medium data-[status=active]:text-foreground",
);

export function SettingsShell({
  crumbs,
  label,
  links,
  children,
}: {
  crumbs: Crumb[];
  label: string;
  // One list item per page, each holding its link.
  links: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader crumbs={crumbs} />
      <div className={cn(pageWidth, "relative flex flex-col gap-8 p-4 pb-12")}>
        <nav aria-label={label} className="2xl:absolute 2xl:top-4 2xl:right-full 2xl:w-48">
          <ul className="flex gap-1 overflow-x-auto border-b pb-2 2xl:flex-col 2xl:border-none 2xl:pb-0">
            {links}
          </ul>
        </nav>
        {children}
      </div>
    </>
  );
}
