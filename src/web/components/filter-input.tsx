// The search box that narrows a list, at the inputs' height, with a magnifier. It is named by its
// label, which is also its placeholder unless it has one.

import { cn } from "cn";
import { SearchIcon } from "lucide-react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/web/components/ui/input-group";

export function FilterInput({
  label,
  placeholder = label,
  value,
  onChange,
  className,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <InputGroup className={cn("h-8", className)}>
      <InputGroupInput
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
    </InputGroup>
  );
}
