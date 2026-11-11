// A connection's proxy: a base URL that replaces the provider's for model lists and replies, and
// headers added to them. The fields serve a key being added as well as a connection's own form in
// a dialog, which saves or clears them; stored header values are never shown.

import { type FormEvent, useId, useState } from "react";

import type { ConnectionSummary } from "@/shared/connections.ts";
import { type HostId, hostOf } from "@/shared/hosts.ts";
import { Button } from "@/web/components/ui/button";
import { DialogFooter } from "@/web/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/web/components/ui/field";
import { type HeaderRow, HeaderRows } from "@/web/components/header-rows";
import { Input } from "@/web/components/ui/input";
import { useSaveProxy } from "@/web/models/mutations";

// Where a connection sends its requests without a proxy: its host's address, or the server's or
// resource's it was given.
export function defaultBaseUrl(host: HostId, settings: Record<string, string> = {}) {
  return settings.baseUrl ?? settings.endpoint ?? hostOf(host).baseUrl ?? "";
}

export interface ProxyDraft {
  baseUrl: string;
  rows: HeaderRow[];
}

export function emptyProxy(): ProxyDraft {
  return { baseUrl: "", rows: [] };
}

// The proxy as the API takes it: a stored header left blank keeps its value.
export function proxyBody(draft: ProxyDraft) {
  return {
    baseUrl: draft.baseUrl.trim() || null,
    headers: Object.fromEntries(
      draft.rows
        .filter((row) => row.name.trim())
        .map((row) => [row.name.trim(), row.value || (row.stored ? null : "")]),
    ),
  };
}

export function ProxyFields({
  draft,
  onChange,
  placeholder,
}: {
  draft: ProxyDraft;
  onChange: (draft: ProxyDraft) => void;
  // The address requests go to without one.
  placeholder: string;
}) {
  const id = useId();
  const { rows } = draft;

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-base`}>Base URL</FieldLabel>
        <Input
          id={`${id}-base`}
          value={draft.baseUrl}
          onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
          placeholder={placeholder || "https://proxy.example.com"}
          autoComplete="off"
        />
        <FieldDescription>
          Model lists and replies go here instead. Signing in and renewing do not.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Headers</FieldLabel>
        <HeaderRows rows={rows} onChange={(next) => onChange({ ...draft, rows: next })} />
      </Field>
    </>
  );
}

// The connection's proxy as a form that saves it, or clears it.
export function ProxyForm({ connection }: { connection: ConnectionSummary }) {
  const { proxy } = connection;
  const [draft, setDraft] = useState<ProxyDraft>(() => ({
    baseUrl: proxy?.baseUrl ?? "",
    rows: (proxy?.headerNames ?? []).map((name, key) => ({ key, name, value: "", stored: true })),
  }));
  const [saved, setSaved] = useState<"saved" | "cleared">();
  const saveProxy = useSaveProxy(connection.id);

  function save(json: { baseUrl: string | null; headers: Record<string, string | null> }) {
    setSaved(undefined);
    saveProxy.mutate(json, {
      onSuccess: () => {
        // Every value is stored now.
        setDraft((current) => ({
          ...current,
          rows: current.rows
            .filter((row) => row.name.trim())
            .map((row) => ({
              ...row,
              name: row.name.trim().toLowerCase(),
              value: "",
              stored: true,
            })),
        }));
        setSaved(json.baseUrl || Object.keys(json.headers).length > 0 ? "saved" : "cleared");
      },
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save(proxyBody(draft));
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <ProxyFields
          draft={draft}
          onChange={setDraft}
          placeholder={defaultBaseUrl(connection.host, connection.settings)}
        />
        <FieldError>{saveProxy.error?.message}</FieldError>
        {saved && (
          <p role="status" className="text-sm text-muted-foreground">
            {saved === "saved" ? "Proxy saved." : "Proxy cleared."}
          </p>
        )}
      </FieldGroup>
      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="outline"
          disabled={saveProxy.isPending || !proxy}
          onClick={() => {
            setDraft({ baseUrl: "", rows: [] });
            save({ baseUrl: null, headers: {} });
          }}
        >
          Clear
        </Button>
        <Button type="submit" disabled={saveProxy.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
