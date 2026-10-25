// Adding a model provider, step by step in one dialog: the host, found in a searchable grid by
// kind, then how to connect to it where there is more than one way, then the fields that way asks
// for (with an optional name, and a proxy it is checked through) or the sign-in, and finally how
// many models it brought, with a shortcut to make one of them the default, or why they could not
// be read. Back goes a step back; refused details say why on their step.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CloudIcon,
  KeyRoundIcon,
  LogInIcon,
  RotateCcwIcon,
  ServerIcon,
} from "lucide-react";
import { cn } from "cn";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { connectionSchema, type ConnectionSummary, connectionLabel } from "@/shared/connections.ts";
import {
  type AuthKind,
  type Field as HostField,
  HOST_GROUPS,
  HOST_IDS,
  type HostGroup,
  type HostId,
  hostOf,
  type Method,
} from "@/shared/hosts.ts";
import { WithTooltip } from "@/web/components/with-tooltip";
import { HostMark } from "@/web/components/marks";
import { ModelPicker } from "@/web/components/model-picker";
import { CodexSignIn } from "@/web/components/settings/codex-sign-in";
import {
  defaultBaseUrl,
  emptyProxy,
  type ProxyDraft,
  ProxyFields,
  proxyBody,
} from "@/web/components/settings/proxy-settings";
import { Button } from "@/web/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { Textarea } from "@/web/components/ui/textarea";
import { apiClient } from "@/web/lib/api-client";
import { errorOf } from "@/web/lib/api-errors";
import { connectionsQuery, defaultModelQuery, modelsQuery } from "@/web/lib/queries";

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

// Every host by its kind, as tiles of its mark, name and what it connects with, found by any of
// them; one already signed in to is shown but cannot be chosen.
function HostGrid({
  hosts,
  taken,
  onSelect,
}: {
  hosts: HostId[];
  taken: (host: HostId) => boolean;
  onSelect: (host: HostId) => void;
}) {
  const groups = (Object.keys(HOST_GROUPS) as HostGroup[])
    .map((group) => ({ group, hosts: hosts.filter((host) => hostOf(host).group === group) }))
    .filter(({ hosts: list }) => list.length > 0);
  return (
    <Command className="rounded-none! bg-transparent p-0">
      <CommandInput placeholder="Search providers" aria-label="Search providers" autoFocus />
      <CommandList className="max-h-[min(60vh,30rem)]">
        <CommandEmpty>No providers found.</CommandEmpty>
        {groups.map(({ group, hosts: list }) => (
          <CommandGroup
            key={group}
            heading={HOST_GROUPS[group]}
            className="px-0 **:[[cmdk-group-items]]:grid **:[[cmdk-group-items]]:grid-cols-2 **:[[cmdk-group-items]]:gap-1 sm:**:[[cmdk-group-items]]:grid-cols-3"
          >
            {list.map((host) => {
              const { label, hint } = hostOf(host);
              const connected = taken(host);
              return (
                <CommandItem
                  key={host}
                  value={host}
                  keywords={[label, hint, HOST_GROUPS[group]]}
                  aria-label={`${label} · ${connected ? "Already connected" : hint}`}
                  disabled={connected}
                  onSelect={() => onSelect(host)}
                  className="items-start gap-2.5 rounded-lg! border border-transparent p-2 data-selected:border-border [&>svg:last-child]:hidden"
                >
                  <HostMark host={host} className="mt-0.5 size-5" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {connected ? "Already connected" : hint}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

// One field of a way of connecting, as the kind of input its value takes.
function FieldInput({
  id,
  field,
  value,
  onChange,
  autoFocus,
}: {
  id: string;
  field: HostField;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const common = {
    id,
    value,
    required: field.required,
    placeholder: field.placeholder,
    autoComplete: "off",
    autoFocus,
  };
  switch (field.kind) {
    case "choice":
      return (
        <Select value={value} onValueChange={(next) => onChange(String(next ?? ""))}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {field.options?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "json":
    case "list":
      return (
        <Textarea
          {...common}
          rows={field.kind === "json" ? 4 : 3}
          spellCheck={false}
          className={cn("max-h-40", field.kind === "json" && "font-mono text-xs")}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <Input
          {...common}
          type={
            field.kind === "secret" && !field.shown
              ? "password"
              : field.kind === "url"
                ? "url"
                : "text"
          }
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

function CredentialsStep({
  host,
  method,
  onAdded,
}: {
  host: HostId;
  method: Method;
  onAdded: (connection: ConnectionSummary) => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(method.fields.map((field) => [field.name, field.initial ?? ""])),
  );
  const [label, setLabel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [proxy, setProxy] = useState<ProxyDraft>(emptyProxy);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const missing = method.fields.some((field) => field.required && !values[field.name]?.trim());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const body = proxyBody(proxy);
    const headers = Object.fromEntries(
      Object.entries(body.headers).map(([name, value]) => [name, value ?? ""]),
    );
    const res = await apiClient.v1.connections.$post({
      json: {
        host,
        method: method.id,
        label: label.trim() || null,
        values,
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
        {method.fields.map((field, index) => (
          <Field key={field.name}>
            <FieldLabel htmlFor={`${id}-${field.name}`}>{field.label}</FieldLabel>
            <FieldInput
              id={`${id}-${field.name}`}
              field={field}
              value={values[field.name] ?? ""}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              autoFocus={index === method.fields.findIndex((f) => !f.initial)}
            />
            {field.description && <FieldDescription>{field.description}</FieldDescription>}
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor={`${id}-label`}>Label</FieldLabel>
          <Input
            id={`${id}-label`}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Optional"
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
                Check and use the connection through another address, with headers of your own.
              </p>
            </div>
            <ProxyFields
              draft={proxy}
              onChange={setProxy}
              placeholder={defaultBaseUrl(host, values)}
            />
          </section>
        )}
        <FieldError>{error}</FieldError>
      </FieldGroup>
      <DialogFooter className="mt-4">
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={pending || missing}>
          {pending ? "Checking…" : method.authKind === "api_key" ? "Add key" : "Connect"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// "an" before a vowel.
function article(word: string) {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function DoneStep({ connection, onClose }: { connection: ConnectionSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const id = useId();
  const models = useQuery(modelsQuery);
  const current = useQuery(defaultModelQuery);
  const [error, setError] = useState<string>();
  const theirs = (models.data?.models ?? []).filter((m) => m.connectionId === connection.id);
  const count = theirs.length;
  const failed = models.data?.errors.find((e) => e.connectionId === connection.id);

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
