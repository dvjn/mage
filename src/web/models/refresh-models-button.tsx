// Reads every provider's models again: an icon button, named by its tooltip.

import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";

export function RefreshModelsButton({
  pending,
  onRefresh,
}: {
  pending: boolean;
  onRefresh: () => void;
}) {
  return (
    <WithTooltip label="Refresh models">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Refresh models"
        disabled={pending}
        onClick={onRefresh}
      >
        <RefreshCwIcon className={pending ? "animate-spin" : undefined} />
      </Button>
    </WithTooltip>
  );
}
