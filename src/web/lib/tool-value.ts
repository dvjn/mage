// How a tool call's input or output is laid out, from the value and its JSON Schema alone: an object
// as labelled fields in the schema's order, then any other keys, each labelled with its schema
// title or else its key; text, numbers, yes or no, and none
// inline; a list of plain values as one list, a list of objects as nested ones; and past two levels
// of nesting under its fields, the JSON itself. A call's result is read as MCP's CallToolResult: its structured
// content laid out the same, its text parts as text, and an error as its text.

import type { JsonSchema } from "@/shared/tools.ts";

export type Scalar = string | number | boolean | null;

export type ValueLayout =
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "none" }
  | { kind: "list"; items: Scalar[] }
  | { kind: "items"; items: ValueLayout[] }
  | { kind: "fields"; fields: FieldLayout[] }
  | { kind: "json"; json: string };

export interface FieldLayout {
  key: string;
  label: string;
  value: ValueLayout;
}

// How deep objects nest before the JSON shows instead: the value's own fields, and two levels
// under them. A list's items sit at the list's level.
const MAX_DEPTH = 3;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function schemaAt(schema: JsonSchema | undefined, key: "properties" | "items") {
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

export function layoutOf(value: unknown, schema?: JsonSchema, depth = 0): ValueLayout {
  if (value === null || value === undefined) return { kind: "none" };
  if (typeof value === "string") return { kind: "text", text: value };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return { kind: "list", items: value };
    if (depth >= MAX_DEPTH) return { kind: "json", json: JSON.stringify(value, null, 2) };
    const items = concrete(schemaAt(concrete(schema), "items"));
    return { kind: "items", items: value.map((item) => layoutOf(item, items, depth)) };
  }
  if (!isObject(value) || depth >= MAX_DEPTH) {
    return { kind: "json", json: JSON.stringify(value, null, 2) };
  }
  const properties = schemaAt(concrete(schema), "properties") ?? {};
  const keys = [
    ...Object.keys(properties).filter((key) => key in value),
    ...Object.keys(value).filter((key) => !(key in properties)),
  ];
  return {
    kind: "fields",
    fields: keys.map((key) => {
      const property = concrete(isObject(properties[key]) ? properties[key] : undefined);
      const title = property?.title;
      return {
        key,
        label: typeof title === "string" ? title : key,
        value: layoutOf(value[key], property, depth + 1),
      };
    }),
  };
}

// MCP's result of a tool call.
export interface CallToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// A call's output as MCP gives it back: what it returned, as structured content when it is an
// object and as text always, or why it failed.
export function callResultOf(
  output: { ok: true; value: unknown } | { ok: false; error: string },
): CallToolResult {
  if (!output.ok) return { content: [{ type: "text", text: output.error }], isError: true };
  const { value } = output;
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isObject(value) && { structuredContent: value }),
  };
}
