// The organization's settings: its pages, listed in one place so more slot in, beside the page
// open; a team org adds its people and, for its owners, its spaces.

import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { BlocksIcon, LayoutGridIcon, Settings2Icon, UsersIcon, WrenchIcon } from "lucide-react";

import { SettingsShell, settingsNavLink } from "@/web/components/settings/settings-nav";
import { meQuery } from "@/web/lib/queries";

export const ORG_PAGES = [
  { to: "/org/general", label: "General", icon: Settings2Icon, team: false, owners: false },
  { to: "/org/providers", label: "Model providers", icon: BlocksIcon, team: false, owners: false },
  { to: "/org/tools", label: "Tools", icon: WrenchIcon, team: false, owners: false },
  { to: "/org/people", label: "People", icon: UsersIcon, team: true, owners: false },
  { to: "/org/spaces", label: "Spaces", icon: LayoutGridIcon, team: true, owners: true },
] as const;

export function OrgShell() {
  const me = useQuery(meQuery);
  const team = me.data?.org.kind === "team";
  const owner = me.data?.role === "owner";
  const pages = ORG_PAGES.filter((page) => (!page.team || team) && (!page.owners || owner));
  return (
    <SettingsShell
      crumbs={[{ label: "Organization settings" }]}
      label="Organization settings"
      links={pages.map(({ to, label, icon: Icon }) => (
        <li key={to} className="shrink-0">
          <Link to={to} className={settingsNavLink}>
            <Icon className="size-4" />
            {label}
          </Link>
        </li>
      ))}
    >
      <Outlet />
    </SettingsShell>
  );
}
