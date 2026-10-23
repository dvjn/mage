// The organization's settings: its pages, listed in one place so more slot in, beside the page
// open. The list sits left of the page's column on a wide screen and as tabs above it otherwise,
// so the column lines up with every other settings page.

import { cn } from "cn";
import { Link, Outlet } from "@tanstack/react-router";
import { BlocksIcon, Settings2Icon } from "lucide-react";

import { PageHeader, pageWidth } from "@/web/components/app-shell";

export const ORG_PAGES = [
  { to: "/org/general", label: "General", icon: Settings2Icon },
  { to: "/org/providers", label: "Model providers", icon: BlocksIcon },
] as const;

export function OrgShell() {
  return (
    <>
      <PageHeader crumbs={[{ label: "Organization settings" }]} />
      <div className={cn(pageWidth, "relative flex flex-col gap-8 p-4 pb-12")}>
        <nav
          aria-label="Organization settings"
          className="2xl:absolute 2xl:top-4 2xl:right-full 2xl:w-48"
        >
          <ul className="flex gap-1 overflow-x-auto border-b pb-2 2xl:flex-col 2xl:border-none 2xl:pb-0">
            {ORG_PAGES.map(({ to, label, icon: Icon }) => (
              <li key={to} className="shrink-0">
                <Link
                  to={to}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                    "data-[status=active]:bg-muted data-[status=active]:font-medium data-[status=active]:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Outlet />
      </div>
    </>
  );
}
