// Adding a model provider, step by step in one dialog: the host, then how to connect to it where
// there is more than one way, then the fields that way asks for (with an optional name, and a proxy
// it is checked through) or the sign-in, and finally how many models it brought, with a shortcut to
// make one of them the default, or why they could not be read. Back goes a step back; refused
// details say why on their step.

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CloudIcon,
  KeyRoundIcon,
  LogInIcon,
  RotateCcwIcon,
  ServerIcon,
} from "lucide-react";
import { cn } from "cn";
import { type ReactNode, useId, useState } from "react";

import { type ConnectionSummary, connectionLabel } from "@/shared/connections.ts";
import { type AuthKind, HOST_IDS, type HostId, hostOf } from "@/shared/hosts.ts";
import { WithTooltip } from "@/web/components/with-tooltip";
import { HostMark } from "@/web/models/marks";
import { ModelPicker } from "@/web/models/model-picker";
import { CodexSignIn } from "@/web/models/codex-sign-in";
import { Button } from "@/web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/web/components/ui/field";
import { defaultModelQuery, modelsQuery } from "@/web/models/queries";
import { Choice, HostGrid } from "@/web/models/host-grid";
import { CredentialsStep } from "@/web/models/provider-fields";
import { useModelSetting } from "@/web/models/mutations";

type Step =
  | { name: "host" }
  | { name: "method"; host: HostId }
  | { name: "credentials"; host: HostId; method: string }
  | { name: "done"; connection: ConnectionSummary };

const METHOD_ICONS: Record<AuthKind, ReactNode> = {
  api_key: <KeyRoundIcon />,
  oauth: <LogInIcon />,
  cloud: <CloudIcon />,
  endpoint: <ServerIcon />,
};

// "an" before a vowel.
function article(word: string) {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function DoneStep({ connection, onClose }: { connection: ConnectionSummary; onClose: () => void }) {
  const id = useId();
  const models = useQuery(modelsQuery);
  const current = useQuery(defaultModelQuery);
  const setting = useModelSetting();
  const theirs = (models.data?.models ?? []).filter((m) => m.connectionId === connection.id);
  const count = theirs.length;
  const failed = models.data?.errors.find((e) => e.connectionId === connection.id);

  function makeDefault(ref: string) {
    setting.mutate({ setting: "default-model", ref });
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex items-center gap-2">
        <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400" />
        <span className="font-medium">
          Connected ·{" "}
          {models.isPending
            ? "reading models…"
            : failed
              ? "couldn't load its models"
              : `${count} ${count === 1 ? "model" : "models"} found`}
        </span>
      </div>
      {failed && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{failed.message}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={models.isFetching}
            onClick={() => void models.refetch()}
          >
            <RotateCcwIcon />
            Try again
          </Button>
        </div>
      )}
      {count > 0 && (
        <Field>
          <FieldLabel htmlFor={`${id}-default`}>Set as default model (optional)</FieldLabel>
          <ModelPicker
            id={`${id}-default`}
            models={theirs}
            value={
              theirs.some((m) => m.ref === current.data?.ref) ? (current.data?.ref ?? null) : null
            }
            onChange={makeDefault}
            placeholder="Keep the current default"
          />
          <FieldError>{setting.error?.message}</FieldError>
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
  // Leaves out the subscription sign-ins.
  apiKeysOnly?: boolean;
}) {
  const [step, setStep] = useState<Step>({ name: "host" });
  const methods = (host: HostId) =>
    hostOf(host).methods.filter((method) => !apiKeysOnly || method.authKind !== "oauth");
  const hosts = HOST_IDS.filter((host) => methods(host).length > 0);
  const methodIn = (host: HostId, id: string) => methods(host).find((m) => m.id === id);

  function close() {
    onOpenChange(false);
    setStep({ name: "host" });
  }

  function back() {
    if (step.name === "method") setStep({ name: "host" });
    else if (step.name === "credentials") {
      setStep(
        methods(step.host).length > 1 ? { name: "method", host: step.host } : { name: "host" },
      );
    }
  }

  function choose(host: HostId) {
    const list = methods(host);
    setStep(
      list.length > 1
        ? { name: "method", host }
        : { name: "credentials", host, method: list[0]!.id },
    );
  }

  // One sign-in of each host per org.
  const signedIn = (host: HostId) =>
    methods(host).every((m) => m.authKind === "oauth") &&
    connections.some((c) => c.authKind === "oauth" && c.host === host);

  const method = step.name === "credentials" ? methodIn(step.host, step.method) : undefined;
  const hostLabel =
    step.name === "method" || step.name === "credentials" ? hostOf(step.host).label : "";
  const titles: Record<Step["name"], string> = {
    host: "Add a model provider",
    method: `Connect ${hostLabel}`,
    credentials: !method
      ? ""
      : method.authKind === "oauth"
        ? method.title
        : method.title === "API key"
          ? `Add ${article(hostLabel)} ${hostLabel} API key`
          : `Connect ${hostLabel}`,
    done: step.name === "done" ? connectionLabel(step.connection) : "",
  };
  const descriptions: Partial<Record<Step["name"], string>> = {
    credentials:
      method && method.authKind !== "oauth" && method.title !== "API key"
        ? `${method.title}. ${method.description}`
        : undefined,
    done: "Its models are now in this organization's model pickers.",
  };
  // A host with one way to connect skips choosing it.
  const host =
    step.name === "done" ? step.connection.host : step.name === "host" ? undefined : step.host;
  const choosing = host ? methods(host).length > 1 : true;
  const steps = choosing ? 4 : 3;
  const number = {
    host: 1,
    method: 2,
    credentials: choosing ? 3 : 2,
    done: steps,
  }[step.name];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className={cn("sm:max-w-lg", step.name === "host" && "sm:max-w-2xl")}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            {(step.name === "method" || step.name === "credentials") && (
              <WithTooltip label="Back">
                <Button size="icon-sm" variant="ghost" aria-label="Back" onClick={back}>
                  <ArrowLeftIcon />
                </Button>
              </WithTooltip>
            )}
            {host && step.name !== "done" && <HostMark host={host} />}
            <DialogTitle>{titles[step.name]}</DialogTitle>
          </div>
          <DialogDescription className={cn(!descriptions[step.name] && "sr-only")}>
            <span className="sr-only">
              Step {number} of {steps}.{" "}
            </span>
            {descriptions[step.name]}
          </DialogDescription>
          <ol aria-hidden className="flex gap-1 pt-1">
            {Array.from({ length: steps }, (_, i) => i + 1).map((n) => (
              <li
                key={n}
                className={cn("h-1 flex-1 rounded-full bg-muted", n <= number && "bg-primary")}
              />
            ))}
          </ol>
        </DialogHeader>
        {step.name === "host" && <HostGrid hosts={hosts} taken={signedIn} onSelect={choose} />}
        {step.name === "method" && (
          <div className="flex flex-col gap-2">
            {methods(step.host).map(({ id, authKind, title, description }) => (
              <Choice
                key={id}
                title={title}
                icon={METHOD_ICONS[authKind]}
                description={description}
                onSelect={() => setStep({ name: "credentials", host: step.host, method: id })}
              />
            ))}
          </div>
        )}
        {step.name === "credentials" && method?.authKind === "oauth" && (
          <CodexSignIn onConnected={(connection) => setStep({ name: "done", connection })} />
        )}
        {step.name === "credentials" && method && method.authKind !== "oauth" && (
          <CredentialsStep
            key={`${step.host}/${method.id}`}
            host={step.host}
            method={method}
            onAdded={(connection) => setStep({ name: "done", connection })}
          />
        )}
        {step.name === "done" && <DoneStep connection={step.connection} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}
