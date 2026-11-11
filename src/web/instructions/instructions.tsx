// The agent's instructions in settings, on the org's and a space's General page: Markdown added to
// every thread's prompt, warned about once long and refused past a cap. In a space, the org's show
// read-only above the space's own. Only those who manage a scope change it; others read it.

import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { INSTRUCTIONS_LONG, INSTRUCTIONS_MAX } from "@/shared/instructions.ts";
import { SaveBar } from "@/web/shell/save-bar";
import { SettingsCard } from "@/web/shell/settings-page";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/web/components/ui/collapsible";
import { FieldError } from "@/web/components/ui/field";
import { Textarea } from "@/web/components/ui/textarea";
import { meQuery } from "@/web/auth/queries";
import { orgInstructionsQuery, spaceInstructionsQuery } from "@/web/instructions/queries";
import type { Scope } from "@/web/shell/scope";
import { useSaveInstructions } from "@/web/instructions/mutations";

export function OrgInstructions() {
  const me = useQuery(meQuery);
  const canManage = me.data?.role === "owner";
  const instructions = useQuery(orgInstructionsQuery);
  return (
    <SettingsCard
      title="Instructions"
      description={
        canManage
          ? "Added to every thread's prompt, in every space."
          : "Added to every thread's prompt, in every space. Only the organization's owners change this."
      }
      state={instructions}
    >
      {instructions.data && (
        <InstructionsForm
          scope={{ kind: "org" }}
          canManage={canManage}
          saved={instructions.data.text}
          placeholder="How the agent should behave"
        />
      )}
    </SettingsCard>
  );
}

export function SpaceInstructions({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const instructions = useQuery(spaceInstructionsQuery(spaceId));
  return (
    <SettingsCard
      title="Instructions"
      description="Added to every thread's prompt here, after the organization's."
      state={instructions}
    >
      {instructions.data && (
        <InstructionsForm
          key={spaceId}
          scope={{ kind: "space", spaceId }}
          canManage
          saved={instructions.data.own.text}
          orgText={instructions.data.org.text}
          placeholder={`Anything specific to ${spaceName}`}
        />
      )}
    </SettingsCard>
  );
}

function InstructionsForm({
  scope,
  canManage,
  saved,
  orgText,
  placeholder,
}: {
  scope: Scope;
  canManage: boolean;
  saved: string;
  orgText?: string;
  placeholder: string;
}) {
  const [text, setText] = useState(saved);
  const [justSaved, setJustSaved] = useState(false);
  const saveText = useSaveInstructions(scope);
  const dirty = text !== saved;
  const tooLong = text.length > INSTRUCTIONS_MAX;

  function save() {
    saveText.mutate(text, { onSuccess: () => setJustSaved(true) });
  }

  return (
    <div className="flex flex-col gap-3">
      {orgText !== undefined && (
        <Collapsible className="rounded-md border px-3 py-2 text-sm">
          <CollapsibleTrigger className="group/org flex w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-4 transition-transform group-data-[panel-open]/org:rotate-90" />
            The organization's instructions
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-64 overflow-auto font-sans text-sm whitespace-pre-wrap text-muted-foreground">
              {orgText || "None"}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
      <Textarea
        aria-label="Instructions"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setJustSaved(false);
        }}
        placeholder={canManage ? placeholder : "No instructions."}
        readOnly={!canManage}
        aria-invalid={tooLong}
        className="min-h-40 font-mono text-sm"
      />
      {canManage && tooLong ? (
        <p role="alert" className="text-sm text-destructive">
          Too long to save.
        </p>
      ) : (
        canManage &&
        text.length > INSTRUCTIONS_LONG && (
          <p className="text-sm text-tool-ask">
            Long instructions are sent with every message, which costs more.
          </p>
        )
      )}
      <FieldError>{saveText.error?.message}</FieldError>
      {canManage && (
        <SaveBar
          dirty={dirty}
          pending={saveText.isPending}
          disabled={tooLong}
          onSave={save}
          onDiscard={() => setText(saved)}
        >
          {justSaved && !dirty && <span className="text-xs text-muted-foreground">Saved</span>}
        </SaveBar>
      )}
    </div>
  );
}
