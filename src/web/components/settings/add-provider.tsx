// Adding a model provider, step by step in one dialog: the provider, then how to connect to it
// where there is more than one way, then the key (with an optional proxy it is checked through) or
// the sign-in, and finally how many models it brought, with a shortcut to make one of them the
// default. Back goes a step back; a refused key says why on its step.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  KeyRoundIcon,
  LogInIcon,
} from "lucide-react";
import { cn } from "cn";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import {
  BACKEND_LABELS,
  connectionSchema,
  type ConnectionSummary,
  connectionLabel,
} from "@/shared/connections.ts";
import { WithTooltip } from "@/web/components/with-tooltip";
import { ModelPicker } from "@/web/components/model-picker";
import { CodexSignIn } from "@/web/components/settings/codex-sign-in";
import {
  emptyProxy,
  type ProxyDraft,
  ProxyFields,
  proxyBody,
} from "@/web/components/settings/proxy-settings";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { Input } from "@/web/components/ui/input";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { connectionsQuery, defaultModelQuery, modelsQuery } from "@/web/lib/queries";

type Provider = "anthropic" | "openai";
type Method = "api_key" | "codex";

type Step =
  | { name: "provider" }
  | { name: "method"; provider: Provider }
  | { name: "credentials"; provider: Provider; method: Method }
  | { name: "done"; connection: ConnectionSummary };

const PROVIDERS: { provider: Provider; description: string; keyDescription: string }[] = [
  {
    provider: "anthropic",
    description: "Claude models, with an API key.",
    keyDescription: "Claude models, with an API key.",
  },
  {
    provider: "openai",
    description: "GPT models, with an API key or a ChatGPT plan.",
    keyDescription: "GPT models, with an API key.",
  },
];

const METHODS: Record<Provider, { method: Method; title: string; description: string }[]> = {
  anthropic: [
    { method: "api_key", title: "API key", description: "Billed per token by Anthropic." },
  ],
  openai: [
    { method: "api_key", title: "API key", description: "Billed per token by OpenAI." },
    {
      method: "codex",
      title: "Sign in with ChatGPT (Codex)",
      description:
        "Your ChatGPT plan, through the Codex sign-in, which OpenAI does not offer to other apps.",
    },
  ],
};

const KEY_PLACEHOLDERS: Record<Provider, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
};

function Choice({
  title,
  description,
  icon,
  disabled,
  onSelect,
}: {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      {icon && <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>}
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function ApiKeyStep({
  provider,
  onAdded,
}: {
  provider: Provider;
  onAdded: (connection: ConnectionSummary) => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [proxy, setProxy] = useState<ProxyDraft>(emptyProxy);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const body = proxyBody(proxy);
    const headers = Object.fromEntries(
      Object.entries(body.headers).map(([name, value]) => [name, value ?? ""]),
    );
    const res = await apiClient.v1.connections["api-keys"].$post({
      json: {
        provider,
        label: label.trim() || null,
        key,
        proxy:
          body.baseUrl || Object.keys(headers).length > 0
            ? { baseUrl: body.baseUrl, headers }
            : null,
      },
    });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    const connection = connectionSchema.parse(await res.json());
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
    onAdded(connection);
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-key`}>API key</FieldLabel>
          <Input
            id={`${id}-key`}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={KEY_PLACEHOLDERS[provider]}
            required
            autoComplete="off"
            autoFocus
          />
          <FieldDescription>
            Checked by listing its models, then kept sealed and never shown again.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-label`}>Label</FieldLabel>
          <Input
            id={`${id}-label`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Optional, as Work or Team"
            maxLength={80}
            autoComplete="off"
          />
        </Field>
        <div>
          <button
            type="button"
            aria-expanded={advanced}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAdvanced(!advanced)}
          >
            Advanced
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", advanced && "rotate-180")}
            />
          </button>
        </div>
        {advanced && (
          <section aria-label="Proxy" className="flex flex-col gap-4">
            <div className="flex flex-col gap-0.5">
              <h3 className="text-sm font-medium">Proxy</h3>
              <p className="text-sm text-muted-foreground">
                Check and use the key through another address, with headers of your own.
              </p>
            </div>
            <ProxyFields draft={proxy} onChange={setProxy} backend={provider} />
          </section>
        )}
        <FieldError>{error}</FieldError>
      </FieldGroup>
      <DialogFooter className="mt-4">
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={pending || !key.trim()}>
          {pending ? "Checking…" : "Add key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DoneStep({ connection, onClose }: { connection: ConnectionSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const models = useQuery(modelsQuery);
  const current = useQuery(defaultModelQuery);
  const [error, setError] = useState<string>();
  const theirs = (models.data?.models ?? []).filter((m) => m.connectionId === connection.id);
  const count = theirs.length;

  async function makeDefault(ref: string) {
    setError(undefined);
    const res = await apiClient.v1.settings["default-model"].$put({ json: { ref } });
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: defaultModelQuery.queryKey });
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex items-center gap-2">
        <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400" />
        <span className="font-medium">
          Connected ·{" "}
          {models.isPending
            ? "reading models…"
            : `${count} ${count === 1 ? "model" : "models"} found`}
        </span>
      </div>
      {count > 0 && (
        <Field>
          <FieldLabel>Set as default model (optional)</FieldLabel>
          <ModelPicker
            models={theirs}
            value={
              theirs.some((m) => m.ref === current.data?.ref) ? (current.data?.ref ?? null) : null
            }
            onChange={(ref) => void makeDefault(ref)}
            placeholder="Keep the current default"
          />
          <FieldError>{error}</FieldError>
        </Field>
      )}
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  );
}

export function AddProviderDialog({
  open,
  onOpenChange,
  connections,
  apiKeysOnly = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionSummary[];
  // A team org connects with API keys only; subscription sign-ins are personal.
  apiKeysOnly?: boolean;
}) {
  const [step, setStep] = useState<Step>({ name: "provider" });
  const methods = (provider: Provider) =>
    apiKeysOnly ? METHODS[provider].filter((m) => m.method === "api_key") : METHODS[provider];

  function close() {
    onOpenChange(false);
    setStep({ name: "provider" });
  }

  function back() {
    if (step.name === "method") setStep({ name: "provider" });
    else if (step.name === "credentials") {
      setStep(
        methods(step.provider).length > 1
          ? { name: "method", provider: step.provider }
          : { name: "provider" },
      );
    }
  }

  // One sign-in of each kind per org.
  const signedIn = (method: Method) =>
    method !== "api_key" && connections.some((c) => c.authKind === method);

  const titles: Record<Step["name"], string> = {
    provider: "Add a model provider",
    method: step.name === "method" ? `Connect ${BACKEND_LABELS[step.provider]}` : "",
    credentials:
      step.name === "credentials"
        ? (methods(step.provider).find((m) => m.method === step.method)?.title ?? "")
        : "",
    done: step.name === "done" ? connectionLabel(step.connection) : "",
  };
  const descriptions: Record<Step["name"], string> = {
    provider: "Which provider should this organization's threads be answered through?",
    method: "How do you want to connect?",
    credentials:
      step.name === "credentials" && step.method === "api_key"
        ? `Paste an ${BACKEND_LABELS[step.provider]} API key.`
        : "Sign in, then come back here.",
    done: "Its models are now in every model picker of this organization.",
  };
  const number = { provider: 1, method: 2, credentials: 3, done: 4 }[step.name];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {(step.name === "method" || step.name === "credentials") && (
              <WithTooltip label="Back">
                <Button size="icon-sm" variant="ghost" aria-label="Back" onClick={back}>
                  <ArrowLeftIcon />
                </Button>
              </WithTooltip>
            )}
            <DialogTitle>{titles[step.name]}</DialogTitle>
          </div>
          <DialogDescription>
            <span className="sr-only">Step {number} of 4. </span>
            {descriptions[step.name]}
          </DialogDescription>
          <ol aria-hidden className="flex gap-1 pt-1">
            {[1, 2, 3, 4].map((n) => (
              <li
                key={n}
                className={cn("h-1 flex-1 rounded-full bg-muted", n <= number && "bg-primary")}
              />
            ))}
          </ol>
        </DialogHeader>
        {step.name === "provider" && (
          <div className="flex flex-col gap-2">
            {PROVIDERS.map(({ provider, description, keyDescription }) => (
              <Choice
                key={provider}
                title={BACKEND_LABELS[provider]}
                description={apiKeysOnly ? keyDescription : description}
                onSelect={() =>
                  setStep(
                    methods(provider).length > 1
                      ? { name: "method", provider }
                      : { name: "credentials", provider, method: "api_key" },
                  )
                }
              />
            ))}
            {apiKeysOnly && (
              <p className="text-xs text-muted-foreground">
                Team organizations connect with API keys. Signing in with a ChatGPT plan is for
                personal organizations.
              </p>
            )}
          </div>
        )}
        {step.name === "method" && (
          <div className="flex flex-col gap-2">
            {methods(step.provider).map(({ method, title, description }) => (
              <Choice
                key={method}
                title={title}
                icon={method === "api_key" ? <KeyRoundIcon /> : <LogInIcon />}
                description={
                  signedIn(method)
                    ? "Already connected. Remove it first to connect another."
                    : description
                }
                disabled={signedIn(method)}
                onSelect={() => setStep({ name: "credentials", provider: step.provider, method })}
              />
            ))}
          </div>
        )}
        {step.name === "credentials" && step.method === "api_key" && (
          <ApiKeyStep
            provider={step.provider}
            onAdded={(connection) => setStep({ name: "done", connection })}
          />
        )}
        {step.name === "credentials" && step.method === "codex" && (
          <CodexSignIn onConnected={(connection) => setStep({ name: "done", connection })} />
        )}
        {step.name === "done" && <DoneStep connection={step.connection} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}
