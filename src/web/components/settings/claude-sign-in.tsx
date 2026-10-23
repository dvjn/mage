// The Claude sign-in: Claude's authorization page opens in a new tab and the person pastes back the
// code it shows; says which connection it made.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  browserStartSchema,
  connectionSchema,
  type ConnectionSummary,
} from "@/shared/connections.ts";
import { openInNewTab, PasteBack } from "@/web/components/settings/sign-in";
import { Button } from "@/web/components/ui/button";
import { Field, FieldError, FieldGroup } from "@/web/components/ui/field";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { connectionsQuery, modelsQuery } from "@/web/lib/queries";

export function ClaudeSignIn({
  onConnected,
}: {
  onConnected: (connection: ConnectionSummary) => void;
}) {
  const queryClient = useQueryClient();
  const [attemptId, setAttemptId] = useState<string>();
  const [error, setError] = useState<string>();

  async function start() {
    setAttemptId(undefined);
    setError(undefined);
    await openInNewTab(async () => {
      const res = await apiClient.v1.connections.claude.browser.$post();
      if (!res.ok) {
        setError(await errorOf(res));
        return null;
      }
      const started = browserStartSchema.parse(await res.json());
      setAttemptId(started.attemptId);
      return started.authorizeUrl;
    });
  }

  async function finish(callbackUrl: string) {
    const res = await apiClient.v1.connections.claude.browser.finish.$post({
      json: { attemptId, callbackUrl },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setAttemptId(undefined);
    setError(undefined);
    const connection = connectionSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
    onConnected(connection);
  }

  return (
    <div>
      <FieldGroup>
        <Field>
          <Button onClick={() => void start()}>Open the Claude sign-in</Button>
        </Field>
        {attemptId && (
          <PasteBack
            label="Code"
            description="After you sign in, Claude shows a code. Copy it and paste it here."
            onSubmit={finish}
          />
        )}
      </FieldGroup>
      <FieldError className="mt-4">{error}</FieldError>
    </div>
  );
}
