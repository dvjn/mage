// The Claude sign-in: Claude's authorization opens in a new tab and the person pastes back the code
// it shows; says which connection it made.

import { type FormEvent, useId, useState } from "react";

import type { ConnectionSummary } from "@/shared/connections.ts";
import { Button } from "@/web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { useFinishClaudeSignIn, useStartClaudeSignIn } from "@/web/models/mutations";

export function ClaudeSignIn({
  onConnected,
}: {
  onConnected: (connection: ConnectionSummary) => void;
}) {
  const id = useId();
  const [attemptId, setAttemptId] = useState<string>();
  const start = useStartClaudeSignIn();
  const finish = useFinishClaudeSignIn();

  function open() {
    finish.reset();
    // Opened before the request so the browser does not block it as a popup.
    const tab = window.open("", "_blank");
    start.mutate(undefined, {
      onSuccess: ({ attemptId: started, authorizeUrl }) => {
        setAttemptId(started);
        if (tab) {
          tab.opener = null;
          tab.location.href = authorizeUrl;
        } else {
          window.open(authorizeUrl, "_blank", "noopener");
        }
      },
      onError: () => tab?.close(),
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attemptId) return;
    const code = new FormData(event.currentTarget).get("code");
    finish.mutate(
      { attemptId, code: typeof code === "string" ? code : "" },
      { onSuccess: onConnected },
    );
  }

  return (
    <div>
      <FieldGroup>
        <Field>
          <Button variant={attemptId ? "outline" : "default"} onClick={open}>
            Open Claude sign-in
          </Button>
          {!attemptId && <FieldDescription>Then paste the code Claude shows.</FieldDescription>}
        </Field>
        {attemptId && (
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={id}>Code</FieldLabel>
                <Input id={id} name="code" required autoComplete="off" autoFocus />
                <FieldDescription>The code Claude shows after you approve.</FieldDescription>
              </Field>
              <Field>
                <Button type="submit" disabled={finish.isPending}>
                  Connect
                </Button>
              </Field>
            </FieldGroup>
          </form>
        )}
      </FieldGroup>
      <FieldError className="mt-4">{start.error?.message ?? finish.error?.message}</FieldError>
    </div>
  );
}
