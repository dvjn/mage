// The fields a way of connecting to a provider asks for, and its optional name. A connection's
// secrets show only their ends, and are kept unless typed again.

import { ChevronDownIcon } from "lucide-react";
import { cn } from "cn";
import { type FormEvent, useId, useState } from "react";

import { type ConnectionSummary } from "@/shared/connections.ts";
import { type Field as HostField, type HostId, type Method } from "@/shared/hosts.ts";
import {
  defaultBaseUrl,
  emptyProxy,
  type ProxyDraft,
  ProxyFields,
  proxyBody,
} from "@/web/models/proxy-settings";
import { Button } from "@/web/components/ui/button";
import { DialogClose, DialogFooter } from "@/web/components/ui/dialog";
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
import { useAddConnection } from "@/web/models/mutations";

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

// The fields a way of connecting asks for, each with its label and description; a secret already
// stored shows its end and may be left blank.
export function MethodFields({
  id,
  method,
  values,
  onChange,
  hints = {},
  autoFocus = true,
}: {
  id: string;
  method: Method;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  hints?: Record<string, string>;
  autoFocus?: boolean;
}) {
  const first = method.fields.findIndex((f) => !f.initial);
  return method.fields.map((field, index) => {
    const hint = isSecret(field) ? hints[field.name] : undefined;
    return (
      <Field key={field.name}>
        <FieldLabel htmlFor={`${id}-${field.name}`}>{field.label}</FieldLabel>
        <FieldInput
          id={`${id}-${field.name}`}
          field={hint ? { ...field, required: false, placeholder: hint } : field}
          value={values[field.name] ?? ""}
          onChange={(value) => onChange({ ...values, [field.name]: value })}
          autoFocus={autoFocus && index === first}
        />
        {field.description && <FieldDescription>{field.description}</FieldDescription>}
      </Field>
    );
  });
}

function isSecret(field: HostField) {
  return field.kind === "secret" || field.kind === "json";
}

// Whether a required field has no value, nor a stored one to keep.
export function missingIn(
  method: Method,
  values: Record<string, string>,
  hints: Record<string, string>,
) {
  return method.fields.some(
    (field) =>
      field.required && !values[field.name]?.trim() && !(isSecret(field) && hints[field.name]),
  );
}

export function CredentialsStep({
  host,
  method,
  onAdded,
}: {
  host: HostId;
  method: Method;
  onAdded: (connection: ConnectionSummary) => void;
}) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(method.fields.map((field) => [field.name, field.initial ?? ""])),
  );
  const [label, setLabel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [proxy, setProxy] = useState<ProxyDraft>(emptyProxy);
  const add = useAddConnection();
  const missing = missingIn(method, values, {});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = proxyBody(proxy);
    const headers = Object.fromEntries(
      Object.entries(body.headers).map(([name, value]) => [name, value ?? ""]),
    );
    add.mutate(
      {
        host,
        method: method.id,
        label: label.trim() || null,
        values,
        proxy:
          body.baseUrl || Object.keys(headers).length > 0
            ? { baseUrl: body.baseUrl, headers }
            : null,
      },
      { onSuccess: onAdded },
    );
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <MethodFields id={id} method={method} values={values} onChange={setValues} />
        <LabelField id={id} value={label} onChange={setLabel} />
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
        <FieldError>{add.error?.message}</FieldError>
      </FieldGroup>
      <DialogFooter className="mt-4">
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={add.isPending || missing}>
          {add.isPending ? "Checking…" : method.authKind === "api_key" ? "Add key" : "Connect"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function LabelField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-label`}>Label</FieldLabel>
      <Input
        id={`${id}-label`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Optional"
        maxLength={80}
        autoComplete="off"
      />
    </Field>
  );
}

// The values a connection's fields start with when changing it: its settings, and every secret
// blank.
export function storedValues(connection: ConnectionSummary, methods: Method[]) {
  const values: Record<string, string> = {};
  for (const field of methods.flatMap((method) => method.fields)) {
    values[field.name] = isSecret(field)
      ? ""
      : (connection.settings[field.name] ?? field.initial ?? "");
  }
  return values;
}
