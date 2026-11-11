// The fields every level of settings picks a model and a reasoning effort with, around the one
// model picker and the one effort picker: a model from the org's list, or the level above's, and
// an effort, or the level above's, each offered first as "Default · X".

import { useId } from "react";

import type { ModelSummary } from "@/shared/models.ts";
import type { Effort } from "@/shared/threads/thread.ts";
import { Field, FieldDescription, FieldLabel } from "@/web/components/ui/field";
import { EffortPicker } from "@/web/models/effort-picker";
import { fallbackReason, ModelPicker, useMissingModel } from "@/web/models/model-picker";
import { parseModelRef } from "@/shared/model-ref.ts";

export { EFFORT_LABELS } from "@/web/models/effort-picker";

// A model's name; one the list does not have is named by its id, never by its ref.
export function modelName(models: ModelSummary[], ref: string | null) {
  if (!ref) return null;
  return (
    models.find((model) => model.ref === ref)?.name ??
    (parseModelRef(ref).modelId || "Unavailable model")
  );
}

// A model, or with `inherit` the level above's, offered first as "Default · X".
export function ModelField({
  label = "Model",
  models,
  value,
  onChange,
  inherit,
  fallback,
  fallbackFor = "space",
  placeholder,
  disabled,
  loading,
  description,
}: {
  label?: string;
  models: ModelSummary[];
  value: string | null;
  onChange: (ref: string | null) => void;
  // The level above's choice, and how it reads, as "Default · GPT Big".
  inherit?: { label: string; ref: string | null };
  // The model used while this choice is turned off or gone, by name, and whose threads use it.
  fallback?: string | null;
  fallbackFor?: "space" | "org";
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  description?: React.ReactNode;
}) {
  const id = useId();
  const missing = useMissingModel(models, value ?? inherit?.ref, loading);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <ModelPicker
        id={id}
        models={models}
        value={value}
        onChange={onChange}
        placeholder={
          models.length === 0 && !loading
            ? "Add a model provider first"
            : (placeholder ?? "Pick a model")
        }
        disabled={disabled || (models.length === 0 && !loading)}
        loading={loading}
        className="min-w-0"
        {...(inherit && {
          inherit: { ...inherit, active: !value, onSelect: () => onChange(null) },
        })}
        {...(missing &&
          fallback && {
            fallback: {
              label: fallbackFor === "org" ? fallback : `Default · ${fallback}`,
              reason: fallbackReason(missing, fallbackFor, fallback),
            },
          })}
      />
      {missing ? (
        <FieldDescription className="text-amber-700 dark:text-amber-400">
          {fallback
            ? fallbackReason(missing, fallbackFor, fallback)
            : `${missing.message} Choose another.`}
        </FieldDescription>
      ) : (
        description && <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}

// A reasoning effort, or the level above's, offered first as `defaultLabel`.
export function EffortField({
  value,
  onChange,
  defaultLabel,
  disabled,
  loading,
  description,
}: {
  value: Effort | null;
  onChange: (effort: Effort | null) => void;
  defaultLabel: string;
  disabled?: boolean;
  loading?: boolean;
  description?: React.ReactNode;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Reasoning effort</FieldLabel>
      <EffortPicker
        id={id}
        value={value}
        onChange={onChange}
        defaultLabel={defaultLabel}
        disabled={disabled}
        loading={loading}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
