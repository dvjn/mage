// Says the app is offline, and why: a slim row at the top of the sidebar, and an icon in the page
// header while the sidebar is out of sight, collapsed or on a phone. What shows is what this
// device kept, and nothing can be sent or changed. Online, neither is there.

import { CloudOffIcon } from "lucide-react";

import { useSidebar } from "@/web/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/web/components/ui/tooltip";
import { type OfflineReason, useOfflineReason } from "@/web/lib/online";

function Why({ reason }: { reason: Exclude<OfflineReason, null> }) {
  return (
    <TooltipContent side="bottom">
      {reason === "network" ? "There is no network." : "The server cannot be reached."} Showing what
      this device kept; you can send and change things once you are back online.
    </TooltipContent>
  );
}

export function SidebarOfflineStatus() {
  const reason = useOfflineReason();
  if (!reason) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="status"
            className="flex h-6 items-center gap-2 px-2 text-xs text-muted-foreground"
          />
        }
      >
        <CloudOffIcon className="size-3.5 shrink-0" aria-hidden />
        Offline
      </TooltipTrigger>
      <Why reason={reason} />
    </Tooltip>
  );
}

export function HeaderOfflineStatus() {
  const reason = useOfflineReason();
  const { isMobile, state } = useSidebar();
  if (!reason || (!isMobile && state === "expanded")) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="status"
            aria-label="Offline"
            className="flex size-7 items-center justify-center text-muted-foreground"
          />
        }
      >
        <CloudOffIcon className="size-4" aria-hidden />
      </TooltipTrigger>
      <Why reason={reason} />
    </Tooltip>
  );
}
