// The signed-in user at the foot of the sidebar, with a menu for the theme, the keyboard shortcuts
// and signing out.

import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, KeyboardIcon, LogOutIcon, SunMoonIcon } from "lucide-react";

import { useToast } from "@/web/shell/toaster";
import { Kbd } from "@/web/components/ui/kbd";
import { useOpenShortcutsHelp } from "@/web/shell/shortcuts-help";
import { type Theme, THEMES, useTheme } from "@/web/shell/theme-provider";
import { Avatar, AvatarFallback } from "@/web/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/web/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/web/components/ui/sidebar";
import { authClient } from "@/web/api/auth-client";
import { shortcutHint } from "@/web/lib/shortcuts";
import { initialsOf } from "@/web/lib/initials";
import { OFFLINE_ERROR } from "@/web/lib/online";
import { forgetCache } from "@/web/api/query-cache";

export function NavUser({ user }: { user: { name: string; email: string } }) {
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openHelp = useOpenShortcutsHelp();
  const toast = useToast();

  async function signOut() {
    // Signing out needs the server, which forgets the session.
    if (!onlineManager.isOnline()) {
      toast(OFFLINE_ERROR);
      return;
    }
    await authClient.signOut();
    await forgetCache(queryClient);
    await navigate({ to: "/login" });
  }

  const who = (
    <>
      <Avatar>
        <AvatarFallback>{initialsOf(user.name)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{user.name}</span>
        <span className="truncate text-xs">{user.email}</span>
      </div>
    </>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="aria-expanded:bg-muted"
                aria-label="Account menu"
              />
            }
          >
            {who}
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{who}</div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SunMoonIcon />
                  Theme
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={theme}
                    onValueChange={(value) => setTheme(value as Theme)}
                  >
                    {THEMES.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={openHelp}>
                <KeyboardIcon />
                Keyboard shortcuts
                <Kbd className="ml-auto">{shortcutHint("help")}</Kbd>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
