// Copies a value to the clipboard, showing a check for two seconds after.

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { WithTooltip } from "@/web/components/with-tooltip";
import { Button } from "@/web/components/ui/button";

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <WithTooltip label={copied ? "Copied" : label}>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={label}
        className={className}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </WithTooltip>
  );
}
