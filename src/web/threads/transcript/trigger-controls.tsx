// The inline buttons of a schedule or webhook for a reader who may change it: a toggle that pauses
// or resumes it, and Delete, which asks first.

import { PauseIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import type { BackgroundWork } from "@/shared/calls.ts";
import { ConfirmDialog } from "@/web/components/confirm-dialog";
import { Button } from "@/web/components/ui/button";
import { WithTooltip } from "@/web/components/with-tooltip";
import { useBackgroundActions } from "@/web/threads/transcript/background";

export function TriggerControls({
  work,
  id,
  name,
}: {
  work: BackgroundWork;
  id: string;
  // What it is called, for the question before it is deleted.
  name: string;
}) {
  const actions = useBackgroundActions()?.schedule;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const paused = work.status === "paused";
  if (!actions) return null;
  function hold(work: Promise<void>) {
    setBusy(true);
    return work.finally(() => setBusy(false));
  }
  return (
    <>
      <WithTooltip label={paused ? "Resume" : "Pause"}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={paused ? "Resume" : "Pause"}
          aria-pressed={paused}
          disabled={busy}
          onClick={() => void hold(paused ? actions.resume(id) : actions.pause(id))}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </Button>
      </WithTooltip>
      <WithTooltip label="Delete">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Delete"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setAsking(true)}
        >
          <Trash2Icon />
        </Button>
      </WithTooltip>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${name}?`}
        description="It stops firing. Its messages stay in the thread."
        action="Delete"
        disabled={busy}
        onConfirm={() => {
          setAsking(false);
          void hold(actions.remove(id));
        }}
      />
    </>
  );
}
