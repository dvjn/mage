// Tries the last run that failed or was stopped again.

import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/web/components/ui/button";

export function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button size="xs" variant="outline" onClick={onRetry}>
      <RotateCcwIcon />
      Retry
    </Button>
  );
}
