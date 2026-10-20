// Settings: connecting the signed-in user's ChatGPT account through the Codex sign-in, with a
// device code or in the browser, and their Claude account through the Claude sign-in; and
// disconnecting them.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import {
  apiErrorSchema,
  attemptSchema,
  browserStartSchema,
  type ConnectionSummary,
  deviceStartSchema,
} from "@/shared/connections.ts";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { Wordmark } from "@/web/components/wordmark";
import { apiClient } from "@/web/lib/api-client";
import { connectionsQuery } from "@/web/lib/queries";

type Method = "device" | "browser";

async function errorOf(res: { json(): Promise<unknown> }) {
  const body = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error : "Something went wrong. Try again.";
}

// Opens a tab before an awaited request so the browser does not block it as a popup.
async function openInNewTab(url: () => Promise<string | null>) {
  const tab = window.open("", "_blank");
  const target = await url();
  if (!target) {
    tab?.close();
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = target;
  } else {
    window.open(target, "_blank", "noopener");
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Copy code"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function Connected({
  connection,
  error,
  onDisconnect,
}: {
  connection: ConnectionSummary;
  error: string | undefined;
  onDisconnect: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <>
      <CardContent>
        <p>
          Connected as <span className="font-medium">{connection.account}</span>
        </p>
        <FieldError className="mt-4">{error}</FieldError>
      </CardContent>
      <CardFooter>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void onDisconnect().finally(() => setPending(false));
          }}
        >
          Disconnect
        </Button>
      </CardFooter>
    </>
  );
}

// Takes the address the browser ended on, or the code, after the user approved.
function PasteBack({
  label,
  description,
  onSubmit,
}: {
  label: string;
  description: string;
  onSubmit: (pasted: string) => Promise<void>;
}) {
  const id = useId();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pasted = new FormData(event.currentTarget).get("callbackUrl");
    setPending(true);
    await onSubmit(typeof pasted === "string" ? pasted : "");
    setPending(false);
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Input id={id} name="callbackUrl" required autoComplete="off" />
          <FieldDescription>{description}</FieldDescription>
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            Connect
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}

function CodexSignIn() {
  const queryClient = useQueryClient();
  const connections = useQuery(connectionsQuery);
  const connection = connections.data?.find((c) => c.authKind === "codex");
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
    reset();
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
  }

  async function disconnect(id: string) {
    const res = await apiClient.v1.connections[":id"].$delete({ param: { id } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    reset();
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in with Codex</CardTitle>
        <CardDescription>
          Use your ChatGPT account, including a work space that allows Codex. This uses the Codex
          sign-in, which OpenAI does not officially offer to other apps.
        </CardDescription>
      </CardHeader>
      {connections.isSuccess &&
        (connection ? (
          <Connected
            connection={connection}
            error={error}
            onDisconnect={() => disconnect(connection.id)}
          />
        ) : (
          <CardContent>
            {waiting ? (
              <FieldGroup>
                <Field>
                  <FieldLabel>Your code</FieldLabel>
                  <div className="flex items-center gap-2">
                    <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">
                      {device.userCode}
                    </code>
                    <CopyButton value={device.userCode} />
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
                  <div className="flex gap-2" role="group" aria-label="Sign-in method">
                    {(["device", "browser"] as const).map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant={method === option ? "secondary" : "ghost"}
                        aria-pressed={method === option}
                        onClick={() => {
                          setMethod(option);
                          reset();
                        }}
                      >
                        {option === "device" ? "Device code" : "Browser"}
                      </Button>
                    ))}
                  </div>
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
                      <FieldDescription>
                        For a browser on the computer Mage runs on, or when the code does not work.
                      </FieldDescription>
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
          </CardContent>
        ))}
    </Card>
  );
}

function ClaudeSignIn() {
  const queryClient = useQueryClient();
  const connections = useQuery(connectionsQuery);
  const connection = connections.data?.find((c) => c.authKind === "claude");
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
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
  }

  async function disconnect(id: string) {
    const res = await apiClient.v1.connections[":id"].$delete({ param: { id } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    setError(undefined);
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in with Claude</CardTitle>
        <CardDescription>
          Use your Claude Pro or Max account. Usage is billed per token from Claude{" "}
          <a
            href="https://claude.ai/settings/usage"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            extra usage
          </a>
          , not your plan&apos;s limits.
        </CardDescription>
      </CardHeader>
      {connections.isSuccess &&
        (connection ? (
          <Connected
            connection={connection}
            error={error}
            onDisconnect={() => disconnect(connection.id)}
          />
        ) : (
          <CardContent>
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
          </CardContent>
        ))}
    </Card>
  );
}

export function Settings() {
  return (
    <div className="flex flex-col gap-6">
      <Wordmark className="self-center" />
      <CodexSignIn />
      <ClaudeSignIn />
      <Link to="/" className="self-center text-sm underline underline-offset-4">
        Back to home
      </Link>
    </div>
  );
}
