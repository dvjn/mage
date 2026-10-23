// The composer's model and reasoning effort pickers, for a thread or a thread not made yet: each
// shows the thread's own choice, or "Default · X" while it follows its space's, then its org's, and
// offers that default first. Model and effort go together: while the model named cannot reply,
// both show the default that replies instead, with its effort. The effort shows only for a model
// that can think. Both read alike, closed, hovered or open, and show a placeholder until the
// models are known.

import type { ModelSummary } from "@/shared/models.ts";
import type { Effort, ThreadDefaults } from "@/shared/threads.ts";
import { EFFORT_LABELS, EffortPicker } from "@/web/components/effort-picker";
import { fallbackReason, ModelPicker, useMissingModel } from "@/web/components/model-picker";
import { modelName } from "@/web/components/settings/default-fields";

// The two triggers' text, alike whatever they show.
const TRIGGER =
  "font-medium text-muted-foreground data-placeholder:text-muted-foreground hover:text-foreground hover:data-placeholder:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground aria-expanded:data-placeholder:text-foreground";

export function ThreadPickers({
  models,
  loading,
  model,
  effort,
  defaults,
  used,
  onModel,
  onEffort,
  open,
  onOpenChange,
}: {
  models: ModelSummary[];
  // The models are still being read.
  loading?: boolean;
  // Null follows the defaults.
  model: string | null;
  effort: Effort | null;
  defaults: ThreadDefaults | undefined;
  // The model that replies while the one named is turned off or gone, by name, with its effort;
  // none when none can.
  used?: { ref: string; name: string; effort: Effort | null } | null;
  onModel: (ref: string | null) => void;
  onEffort: (effort: Effort | null) => void;
  // Opens and closes the model list from outside, when given.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // The default names the model it resolves to: the space's while it can reply, else the org's.
  const defaultRef = defaults?.used?.ref ?? defaults?.model ?? null;
  const defaultModel = defaults?.used?.name ?? modelName(models, defaults?.model ?? null);
  const missing = useMissingModel(models, model ?? defaultRef, loading);
  // The effort the thread takes without its own: with its own model, the default effort; following
  // the defaults, the effort of the default that replies; and the stand-in's while it falls back.
  const inherited = missing
    ? used?.effort
    : model
      ? defaults?.effort
      : defaults?.used
        ? defaults.used.effort
        : defaults?.effort;
  const defaultEffort = EFFORT_LABELS[inherited ?? "medium"];
  // Whether the model that replies can think, so its effort can be chosen.
  const replying = used?.ref ?? (missing ? null : (model ?? defaultRef));
  const thinks = !!models.find((m) => m.ref === replying)?.reasoning;
  return (
    <>
      <ModelPicker
        models={models}
        value={model}
        onChange={onModel}
        {...(open !== undefined && { open })}
        {...(onOpenChange && { onOpenChange })}
        placeholder={defaultModel ? `Default · ${defaultModel}` : "Model"}
        variant="compact"
        loading={loading}
        className={TRIGGER}
        {...(missing &&
          used && {
            fallback: {
              label: `Default · ${used.name}`,
              reason: fallbackReason(missing, "thread"),
            },
          })}
        {...(defaultModel && {
          inherit: {
            label: `Default · ${defaultModel}`,
            ref: defaultRef,
            active: !model,
            onSelect: () => onModel(null),
          },
        })}
      />
      {(thinks || loading) && (
        <EffortPicker
          variant="compact"
          // A thread's own effort goes with its own model, and gives way with it.
          value={missing && used ? null : effort}
          onChange={onEffort}
          defaultLabel={`Default · ${defaultEffort}`}
          loading={loading}
          className={TRIGGER}
        />
      )}
    </>
  );
}
