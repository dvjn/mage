// An editor for the HTTP headers sent with requests: a row each with its name and a hidden value,
// an × to drop it and a button to add one. A stored value is never shown, only the end of it where
// the server tells; left blank, it is kept.

import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { WithTooltip } from "@/web/components/with-tooltip";

export interface HeaderRow {
  key: number;
  name: string;
  value: string;
  // The end of the value stored on the server, kept unless a new one is typed.
  hint?: string;
  // Its value is stored on the server, and kept unless a new one is typed.
  stored: boolean;
}

export function nextHeaderKey(rows: HeaderRow[]) {
  return Math.max(0, ...rows.map((row) => row.key)) + 1;
}

// The headers as the API takes them: a stored one left blank keeps its value.
export function headersBody(rows: HeaderRow[]) {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => ({
      name: row.name.trim(),
      value: row.value || (row.stored ? null : ""),
    }));
}

export function HeaderRows({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  function change(key: number, update: Partial<HeaderRow>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...update } : row)));
  }
  return (
    <>
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
            placeholder={row.stored ? (row.hint ?? "••••") : "Value"}
            autoComplete="off"
          />
          <WithTooltip label="Remove header">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${row.name || "header"}`}
              onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
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
        className="w-fit self-start"
        onClick={() =>
          onChange([...rows, { key: nextHeaderKey(rows), name: "", value: "", stored: false }])
        }
      >
        <PlusIcon />
        Add header
      </Button>
    </>
  );
}
