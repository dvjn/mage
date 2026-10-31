// The signed-in app: the sidebar beside the current page, open or collapsed as it was last left,
// and the thread search and the keyboard shortcuts dialog over both. It follows the person's inbox to keep thread lists current, and
// marks the tab's title while a thread needs them.

import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppSidebar } from "@/web/app/app-sidebar";
import { ShortcutsHelpProvider } from "@/web/shell/shortcuts-help";
import { ThreadSearchProvider } from "@/web/threads/thread-search";
import { SidebarInset, SidebarProvider } from "@/web/components/ui/sidebar";
import { useInbox } from "@/web/threads/inbox";
import { useNeedsYou } from "@/web/threads/needs-you";

// The sidebar records whether it is open in this cookie each time it is toggled.
function sidebarWasOpen() {
  return !document.cookie.split("; ").includes("sidebar_state=false");
}

// The tab's title, marked while some thread needs the person.
function TitleMarker() {
  const marked = useNeedsYou().total > 0;
  useEffect(() => {
    const title = marked ? "● Mage" : "Mage";
    if (document.title !== title) document.title = title;
  }, [marked]);
  return null;
}

export function AppShell() {
  useInbox();
  return (
    <ShortcutsHelpProvider>
      <ThreadSearchProvider>
        {/* The shell fills the window; each page scrolls inside the inset rather than the window. */}
        <SidebarProvider defaultOpen={sidebarWasOpen()} className="h-svh">
          <AppSidebar />
          <SidebarInset className="min-h-0 overflow-y-auto">
            <Outlet />
          </SidebarInset>
          <TitleMarker />
        </SidebarProvider>
      </ThreadSearchProvider>
    </ShortcutsHelpProvider>
  );
}
