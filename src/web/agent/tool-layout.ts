// How a tool call's input or output is laid out, from the value's shape and its JSON Schema: plain
// values as text, numbers, yes or no and none; a list of plain values as chips; a list of objects as
// a table whose columns follow the schema and then every other key; any other object or list as a
// tree of labelled entries. Each layout covers one level, and what sits under it is laid out only
// when it shows. A call's output is laid out by what it returned: why it failed, text as Markdown
// (or its value, when the text is JSON), MCP's content parts one by one, or its value.

import type { JsonSchema } from "@/shared/tools.ts";

export type Scalar = string | number | boolean | null;

// One labelled value under an object or list, with the schema it is laid out by.
export interface Entry {
  key: string;
  label: string;
  value: unknown;
  schema?: JsonSchema;
}

export interface Column {
  key: string;
  label: string;
  schema?: JsonSchema;
}

export type ValueLayout =
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" }
  | { kind: "chips"; items: Scalar[] }
  | { kind: "table"; columns: Column[]; rows: Record<string, unknown>[] }
  | { kind: "tree"; entries: Entry[]; list: boolean };

// One of MCP's content parts as it shows.
export type PartLayout =
  | { kind: "text"; layout: OutputLayout }
  | { kind: "image"; src: string }
  | { kind: "link"; label: string; href?: string }
  | { kind: "other"; label: string };

export type OutputLayout =
  | { kind: "error"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "parts"; parts: PartLayout[] }
  | { kind: "value"; layout: ValueLayout };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function schemaAt(schema: JsonSchema | undefined, key: string) {
  const found = schema?.[key];
  return isObject(found) ? found : undefined;
}

// The schema of a nullable or one-of property, as zod and others write them: the first branch
// that is not null.
function concrete(schema: JsonSchema | undefined): JsonSchema | undefined {
  const branches = schema?.anyOf ?? schema?.oneOf;
  if (!Array.isArray(branches)) return schema;
  const branch = branches.find((candidate) => isObject(candidate) && candidate.type !== "null");
  return isObject(branch) ? { ...branch, ...schema, anyOf: undefined, oneOf: undefined } : schema;
}

function propertiesOf(schema: JsonSchema | undefined) {
  return schemaAt(concrete(schema), "properties") ?? {};
}

function labelled(key: string, properties: Record<string, unknown>) {
  const property = concrete(isObject(properties[key]) ? properties[key] : undefined);
  const title = property?.title;
  return { key, label: typeof title === "string" ? title : key, schema: property };
}

// The keys of an object, or the union of a list of objects', in the schema's order and then as
// they first come.
function keysOf(objects: Record<string, unknown>[], properties: Record<string, unknown>) {
  const seen = new Set<string>();
  for (const object of objects) for (const key of Object.keys(object)) seen.add(key);
  return [
    ...Object.keys(properties).filter((key) => seen.has(key)),
    ...[...seen].filter((key) => !(key in properties)),
  ];
}

// An object's fields, labelled by its schema.
export function entriesOf(value: Record<string, unknown>, schema?: JsonSchema): Entry[] {
  const properties = propertiesOf(schema);
  return keysOf([value], properties).map((key) => ({
    ...labelled(key, properties),
    value: value[key],
  }));
}

export function layoutOf(value: unknown, schema?: JsonSchema): ValueLayout {
  if (value === null || value === undefined) return { kind: "none" };
  if (typeof value === "string") return { kind: "text", text: value };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return { kind: "chips", items: value };
    const items = concrete(schemaAt(concrete(schema), "items"));
    if (value.every(isObject)) {
      const properties = propertiesOf(items);
      return {
        kind: "table",
        columns: keysOf(value, properties).map((key) => labelled(key, properties)),
        rows: value,
      };
    }
    return {
      kind: "tree",
      list: true,
      entries: value.map((item, index) => ({
        key: String(index),
        label: String(index + 1),
        value: item,
        schema: items,
      })),
    };
  }
  return { kind: "tree", list: false, entries: isObject(value) ? entriesOf(value, schema) : [] };
}

// A nested value in a table's cell, as a few words: how many items or fields it has.
export function countOf(value: unknown[] | Record<string, unknown>) {
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  const noun = Array.isArray(value) ? "item" : "field";
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

// The value a text stands for when it is a JSON object or list.
function parsed(text: string): { value: unknown } | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return undefined;
  }
}

function textLayout(text: string, schema?: JsonSchema): OutputLayout {
  const json = parsed(text);
  return json
    ? { kind: "value", layout: layoutOf(json.value, schema) }
    : { kind: "markdown", text };
}

// MCP's content parts, where a value is a result's content.
function partsOf(value: unknown): Record<string, unknown>[] | undefined {
  if (!isObject(value) || !Array.isArray(value.content) || value.content.length === 0) {
    return undefined;
  }
  const { content } = value;
  return content.every((part) => isObject(part) && typeof part.type === "string")
    ? (content as Record<string, unknown>[])
    : undefined;
}

function textOf(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

// Links open only on the web.
function webLink(uri: string | undefined) {
  return uri && /^https?:\/\//i.test(uri) ? uri : undefined;
}

function partOf(part: Record<string, unknown>): PartLayout {
  const mimeType = textOf(part.mimeType);
  switch (part.type) {
    case "text":
      return { kind: "text", layout: textLayout(textOf(part.text) ?? "") };
    case "image": {
      const data = textOf(part.data);
      if (data && mimeType?.startsWith("image/")) {
        return { kind: "image", src: `data:${mimeType};base64,${data}` };
      }
      break;
    }
    case "resource_link": {
      const uri = textOf(part.uri);
      return { kind: "link", label: textOf(part.name) ?? uri ?? "Link", href: webLink(uri) };
    }
    case "resource": {
      const resource = isObject(part.resource) ? part.resource : {};
      const text = textOf(resource.text);
      if (text !== undefined) return { kind: "text", layout: textLayout(text) };
      const uri = textOf(resource.uri);
      if (uri) return { kind: "link", label: uri, href: webLink(uri) };
      break;
    }
  }
  return { kind: "other", label: [String(part.type), mimeType].filter(Boolean).join(" · ") };
}

export function outputLayoutOf(
  output: { ok: true; value: unknown } | { ok: false; error: string },
  schema?: JsonSchema,
): OutputLayout {
  if (!output.ok) return { kind: "error", text: output.error };
  const { value } = output;
  if (typeof value === "string") return textLayout(value, schema);
  const parts = partsOf(value);
  if (parts) return { kind: "parts", parts: parts.map(partOf) };
  return { kind: "value", layout: layoutOf(value, schema) };
}
