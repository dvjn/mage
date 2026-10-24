// A connection's proxy: a base URL that replaces the provider's for model lists and replies, and
// headers added to them. The fields serve a key being added as well as a connection's own form in
// a dialog, which saves or clears them; stored header values are never shown.

import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import type { ConnectionSummary } from "@/shared/connections.ts";
import { type HostId, hostOf } from "@/shared/hosts.ts";
import { WithTooltip } from "@/web/components/with-tooltip";
import { Button } from "@/web/components/ui/button";
import { DialogFooter } from "@/web/components/ui/dialog";
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
import { connectionsQuery, modelsQuery } from "@/web/lib/queries";

// Where a connection sends its requests without a proxy: its host's address, or the server's or
// resource's it was given.
export function defaultBaseUrl(host: HostId, settings: Record<string, string> = {}) {
  return settings.baseUrl ?? settings.endpoint ?? hostOf(host).baseUrl ?? "";
}

export interface HeaderRow {
  key: number;
  name: string;
  value: string;
  // Its value is stored on the server, and kept unless a new one is typed.
  stored: boolean;
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

  function change(key: number, update: Partial<HeaderRow>) {
    onChange({
      ...draft,
      rows: rows.map((row) => (row.key === key ? { ...row, ...update } : row)),
    });
  }

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
        {rows.map((row) => (
          <div key={row.key} className="flex gap-2">
            <Input
              aria-label="Header name"
              value={row.name}
              disabled={row.stored}
              onChange={(event) => change(row.key, { name: event.target.value })}
              placeholder="Name"
              autoComplete="off"
            />
            <Input
              aria-label={`Value of ${row.name || "header"}`}
              type="password"
              value={row.value}
              onChange={(event) => change(row.key, { value: event.target.value })}
              placeholder={row.stored ? "••••" : "Value"}
              autoComplete="off"
            />
            <WithTooltip label="Remove header">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${row.name || "header"}`}
                onClick={() => onChange({ ...draft, rows: rows.filter((r) => r.key !== row.key) })}
              >
                <XIcon />
              </Button>
            </WithTooltip>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() =>
            onChange({
              ...draft,
              rows: [
                ...rows,
                {
                  key: Math.max(0, ...rows.map((r) => r.key)) + 1,
                  name: "",
                  value: "",
                  stored: false,
                },
              ],
            })
          }
        >
          <PlusIcon />
          Add header
        </Button>
      </Field>
    </>
  );
}

// The connection's proxy as a form that saves it, or clears it.
export function ProxyForm({ connection }: { connection: ConnectionSummary }) {
  const queryClient = useQueryClient();
  const { proxy } = connection;
  const [draft, setDraft] = useState<ProxyDraft>(() => ({
    baseUrl: proxy?.baseUrl ?? "",
    rows: (proxy?.headerNames ?? []).map((name, key) => ({ key, name, value: "", stored: true })),
  }));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<"saved" | "cleared">();
  const [pending, setPending] = useState(false);

  async function save(json: { baseUrl: string | null; headers: Record<string, string | null> }) {
    setPending(true);
    setError(undefined);
    setSaved(undefined);
    const res = await apiClient.v1.connections[":id"].proxy.$patch({
      param: { id: connection.id },
      json,
    });
    setPending(false);
    if (!res.ok) {
      setError(await errorOf(res));
      return;
    }
    // Every value is stored now.
    setDraft((current) => ({
      ...current,
      rows: current.rows
        .filter((row) => row.name.trim())
        .map((row) => ({ ...row, name: row.name.trim().toLowerCase(), value: "", stored: true })),
    }));
    setSaved(json.baseUrl || Object.keys(json.headers).length > 0 ? "saved" : "cleared");
    await queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(proxyBody(draft));
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <ProxyFields
          draft={draft}
          onChange={setDraft}
          placeholder={defaultBaseUrl(connection.host, connection.settings)}
        />
        <FieldError>{error}</FieldError>
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
          disabled={pending || !proxy}
          onClick={() => {
            setDraft({ baseUrl: "", rows: [] });
            void save({ baseUrl: null, headers: {} });
          }}
        >
          Clear
        </Button>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
