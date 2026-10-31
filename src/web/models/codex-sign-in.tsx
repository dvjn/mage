// The ChatGPT sign-in: a device code entered at OpenAI from any device; says which connection it
// made.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { attemptSchema, type ConnectionSummary } from "@/shared/connections.ts";
import { apiClient } from "@/web/api/api-client";
import { errorOf } from "@/web/api/api-errors";
import { CopyButton } from "@/web/components/copy-button";
import { Button } from "@/web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { useCancelCodexSignIn, useStartCodexSignIn } from "@/web/models/mutations";
import { connectionsQuery, modelsQuery } from "@/web/models/queries";

export function CodexSignIn({
  onConnected,
}: {
  onConnected: (connection: ConnectionSummary) => void;
}) {
  const queryClient = useQueryClient();
  const [device, setDevice] = useState<{ attemptId: string; userCode: string; url: string }>();
  const start = useStartCodexSignIn();
  const cancel = useCancelCodexSignIn();

  const attempt = useQuery({
    queryKey: ["codex-attempt", device?.attemptId],
    enabled: Boolean(device),
    queryFn: async () => {
      const res = await apiClient.v1.connections.codex.attempts[":id"].$get({
        param: { id: device?.attemptId ?? "" },
      });
      if (!res.ok) return { status: "failed" as const, error: await errorOf(res) };
      const result = attemptSchema.parse(await res.json());
      if (result.status === "connected") {
        await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
        await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
        onConnected(result.connection);
      }
      return result;
    },
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2000 : false),
  });
  const waiting = device && attempt.data?.status !== "failed";
  const shownError =
    start.error?.message ?? (attempt.data?.status === "failed" ? attempt.data.error : undefined);

  function reset() {
    setDevice(undefined);
    start.reset();
  }

  function startDevice() {
    reset();
    start.mutate(undefined, {
      onSuccess: (started) =>
        setDevice({
          attemptId: started.attemptId,
          userCode: started.userCode,
          url: started.verificationUrl,
        }),
    });
  }

  function cancelDevice() {
    if (!device) return reset();
    cancel.mutate(device.attemptId, { onSettled: reset });
  }

  return (
    <div>
      {waiting ? (
        <FieldGroup>
          <Field>
            <FieldLabel>Your code</FieldLabel>
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">
                {device.userCode}
              </code>
              <CopyButton label="Copy code" value={device.userCode} />
            </div>
            <FieldDescription>
              Open{" "}
              <a href={device.url} target="_blank" rel="noreferrer" className="underline">
                {device.url.replace(/^https:\/\//, "")}
              </a>
              , sign in and enter this code. This page updates once you approve.
            </FieldDescription>
          </Field>
          <Field>
            <Button variant="outline" onClick={cancelDevice}>
              Cancel
            </Button>
          </Field>
        </FieldGroup>
      ) : (
        <FieldGroup>
          <Field>
            <Button onClick={startDevice}>Get a code</Button>
            <FieldDescription>
              Enter a code at OpenAI from any device. Works wherever Mage runs.
            </FieldDescription>
          </Field>
        </FieldGroup>
      )}
      <FieldError className="mt-4">{shownError}</FieldError>
    </div>
  );
}
