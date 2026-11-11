// Copies a value to the clipboard, showing a check for two seconds after; and the field that holds
// a link with it.

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { WithTooltip } from "@/web/components/with-tooltip";
import { Button } from "@/web/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";

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

// A read-only field holding a link, selected on focus, with a button that copies it. A secret
// shown once says so.
export function CopyField({
  value,
  label,
  id,
  once,
}: {
  value: string;
  // What the field is called, and what its button copies.
  label: string;
  id?: string;
  // The link cannot be seen again.
  once?: boolean;
}) {
  return (
    <>
      <InputGroup>
        <InputGroupInput
          {...(id && { id })}
          aria-label={label}
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <InputGroupAddon align="inline-end">
          <CopyButton label="Copy link" value={value} />
        </InputGroupAddon>
      </InputGroup>
      {once && <p className="text-xs text-muted-foreground">Copy it now: it is shown only once.</p>}
    </>
  );
}
