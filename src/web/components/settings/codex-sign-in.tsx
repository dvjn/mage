// The Codex sign-in: a device code entered at OpenAI from any device, or a browser sign-in whose
// final address the person pastes back; says which connection it made.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  attemptSchema,
  browserStartSchema,
  connectionSchema,
  type ConnectionSummary,
  deviceStartSchema,
} from "@/shared/connections.ts";
import { CopyButton } from "@/web/components/copy-button";
import { openInNewTab, PasteBack } from "@/web/components/settings/sign-in";
import { SegmentedControl } from "@/web/components/segmented-control";
import { Button } from "@/web/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { connectionsQuery, modelsQuery } from "@/web/lib/queries";

type Method = "device" | "browser";

export function CodexSignIn({
  onConnected,
}: {
  onConnected: (connection: ConnectionSummary) => void;
}) {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<Method>("device");
  const [device, setDevice] = useState<{ attemptId: string; userCode: string; url: string }>();
  const [browserAttempt, setBrowserAttempt] = useState<string>();
  const [error, setError] = useState<string>();

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
  const shownError = error ?? (attempt.data?.status === "failed" ? attempt.data.error : undefined);

  function reset() {
    setDevice(undefined);
    setBrowserAttempt(undefined);
    setError(undefined);
  }

  async function startDevice() {
    reset();
    const res = await apiClient.v1.connections.codex.device.$post();
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const started = deviceStartSchema.parse(await res.json());
    setDevice({
      attemptId: started.attemptId,
      userCode: started.userCode,
      url: started.verificationUrl,
    });
  }

  async function cancelDevice() {
    if (device) {
      await apiClient.v1.connections.codex.attempts[":id"].cancel.$post({
        param: { id: device.attemptId },
      });
    }
    reset();
  }

  async function startBrowser() {
    reset();
    await openInNewTab(async () => {
      const res = await apiClient.v1.connections.codex.browser.$post();
      if (!res.ok) {
        setError(await errorOf(res));
        return null;
      }
      const { attemptId, authorizeUrl } = browserStartSchema.parse(await res.json());
      setBrowserAttempt(attemptId);
      return authorizeUrl;
    });
  }

  async function finishBrowser(callbackUrl: string) {
    const res = await apiClient.v1.connections.codex.browser.finish.$post({
      json: { attemptId: browserAttempt, callbackUrl },
    });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const connection = connectionSchema.parse(await res.json());
    reset();
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
    onConnected(connection);
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
            <Button variant="outline" onClick={() => void cancelDevice()}>
              Cancel
            </Button>
          </Field>
        </FieldGroup>
      ) : (
        <FieldGroup>
          <Field>
            <SegmentedControl
              label="Sign-in method"
              options={[
                { value: "device", label: "Device code" },
                { value: "browser", label: "Browser" },
              ]}
              value={method}
              onChange={(option) => {
                setMethod(option);
                reset();
              }}
            />
            {method === "device" ? (
              <>
                <Button onClick={() => void startDevice()}>Get a code</Button>
                <FieldDescription>
                  Enter a code at OpenAI from any device. Works wherever Mage runs.
                </FieldDescription>
              </>
            ) : (
              <>
                <Button onClick={() => void startBrowser()}>Open the Codex sign-in</Button>
                <FieldDescription>When the code does not work.</FieldDescription>
              </>
            )}
          </Field>
          {method === "browser" && browserAttempt && (
            <PasteBack
              label="Callback URL"
              description="After you sign in, your browser opens a localhost page that does not load. Copy its full address and paste it here."
              onSubmit={finishBrowser}
            />
          )}
        </FieldGroup>
      )}
      <FieldError className="mt-4">{shownError}</FieldError>
    </div>
  );
}
