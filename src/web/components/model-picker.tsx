// A searchable list of the models the org can use, grouped by the connection they come through.
// With no models at all, it points to Settings to connect an account. As a form field it filters
// in place; compact, it is a composer button whose popup holds the search.

import { Link } from "@tanstack/react-router";

import { cn } from "cn";

import type { ModelSummary } from "@/shared/models.ts";
import { promptInputSelectTriggerClassName } from "@/web/components/ai-elements/prompt-input";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/web/components/ui/combobox";
import { selectTriggerClassName } from "@/web/components/ui/select";

export const CONNECTION_LABELS: Record<ModelSummary["authKind"], string> = {
  codex: "Codex",
  claude: "Claude",
};

interface Group {
  value: string;
  items: ModelSummary[];
}

function groupsOf(models: ModelSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const model of models) {
    const group = groups.get(model.connectionId) ?? {
      value: CONNECTION_LABELS[model.authKind],
      items: [],
    };
    group.items.push(model);
    groups.set(model.connectionId, group);
  }
  return [...groups.values()];
}

export function ModelPicker({
  id,
  models,
  value,
  onChange,
  placeholder = "Pick a model",
  disabled,
  className,
  open,
  onOpenChange,
  variant = "field",
}: {
  id?: string;
  models: ModelSummary[];
  value: string | null;
  onChange: (ref: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  // Opens and closes the list from outside, when given.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "field" | "compact";
}) {
  const selected = models.find((model) => model.ref === value) ?? null;
  const groups = groupsOf(models);
  return (
    <Combobox
      items={groups}
      value={selected}
      onValueChange={(model) => {
        if (model) onChange(model.ref);
      }}
      itemToStringLabel={(model: ModelSummary) => model.name}
      isItemEqualToValue={(a: ModelSummary, b: ModelSummary) => a.ref === b.ref}
      disabled={disabled}
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange: (next: boolean) => onOpenChange(next) })}
    >
      {variant === "compact" ? (
        <ComboboxTrigger
          id={id}
          aria-label="Model"
          data-size="sm"
          className={cn(
            selectTriggerClassName,
            promptInputSelectTriggerClassName,
            "max-w-56",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            <ComboboxValue placeholder={value ?? placeholder} />
          </span>
        </ComboboxTrigger>
      ) : (
        <ComboboxInput
          id={id}
          placeholder={value && !selected ? value : placeholder}
          className={className}
          disabled={disabled}
        />
      )}
      <ComboboxContent {...(variant === "compact" && { side: "top" as const, className: "w-64" })}>
        {variant === "compact" && (
          <ComboboxInput
            showTrigger={false}
            placeholder="Search models"
            aria-label="Search models"
          />
        )}
        <ComboboxEmpty>
          {models.length === 0 ? (
            <Link to="/settings" className="underline underline-offset-4">
              Connect an account in Settings
            </Link>
          ) : (
            "No models found."
          )}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: Group, index: number) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(model: ModelSummary) => (
                  <ComboboxItem key={model.ref} value={model}>
                    {model.name}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
              {index < groups.length - 1 && <ComboboxSeparator />}
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
