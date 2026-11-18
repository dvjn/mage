// Tools as Python functions for scripts: each named as the model knows it, its signature written
// from the JSON Schemas of what it takes and gives back, and the names nearest one not found.

import { createHash } from "node:crypto";

type Schema = Record<string, unknown>;

export interface ToolSchemas {
  inputSchema: Schema;
  outputSchema?: Schema;
}

// Choices between whole inputs, which providers refuse at the top of a tool's schema, and how many
// of their branches an input must match. The tool still checks its input against them.
export const TOP_LEVEL_CHOICES = {
  oneOf: "exactly one",
  anyOf: "at least one",
  allOf: "all",
} as const;

// A top-level choice told in words, when each branch only names the parameters it requires.
export function choiceInWords(schema: Record<string, unknown>) {
  const lines = Object.entries(TOP_LEVEL_CHOICES).flatMap(([key, count]) => {
    const branches = schema[key];
    if (!Array.isArray(branches)) return [];
    const sets = branches.map((branch: unknown) => {
      const { required, ...rest } = (branch ?? {}) as { required?: unknown };
      return Array.isArray(required) && Object.keys(rest).length === 0 ? required : null;
    });
    if (sets.some((set) => set === null)) return [];
    const options = sets.map((set) => `(${(set as string[]).join(", ")})`).join(" or ");
    return [`Input constraint: Provide parameters for ${count} of: ${options}.`];
  });
  return lines.join("\n");
}

// How deep objects are spelled out before they are only `dict`.
const DEPTH = 3;

function pythonOf(wireName: string) {
  const name = wireName.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

// Each tool's name for the model as a Python name. One that had to change to be one, and so came to
// be another's, ends in a short hash of its name for the model.
export function functionNames(wireNames: readonly string[]) {
  const taken = new Map<string, number>();
  for (const wire of wireNames) taken.set(pythonOf(wire), (taken.get(pythonOf(wire)) ?? 0) + 1);
  return new Map(
    wireNames.map((wire) => {
      const name = pythonOf(wire);
      const clash = name !== wire && taken.get(name)! > 1;
      const hash = createHash("sha256").update(wire).digest("hex").slice(0, 6);
      return [wire, clash ? `${name}_${hash}` : name];
    }),
  );
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unionOf(types: string[]) {
  const distinct = [...new Set(types)];
  return distinct.includes("Any") ? "Any" : distinct.join(" | ");
}

// How a type is written: in full, or `short`, with values to choose from as their type alone.
interface Writing {
  defs: Schema;
  short: boolean;
}

function literalOf(values: unknown[], writing: Writing) {
  if (!writing.short) return `Literal[${values.map((one) => JSON.stringify(one)).join(", ")}]`;
  return unionOf(
    values.map((one) => (one === null ? "None" : typeOf({ type: jsonType(one) }, writing, 0))),
  );
}

function jsonType(value: unknown) {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return Array.isArray(value) ? "array" : "object";
}

// The schema's type as Python writes it; objects with properties as `{key: type, optional?: type}`.
function typeOf(schema: unknown, writing: Writing, depth: number): string {
  if (!isSchema(schema)) return "Any";
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const target = writing.defs[ref.replace(/^#\/(\$defs|definitions)\//, "")];
    return depth > 0 && isSchema(target) ? typeOf(target, writing, depth - 1) : "Any";
  }
  if ("const" in schema) return literalOf([schema.const], writing);
  if (Array.isArray(schema.enum)) return literalOf(schema.enum, writing);
  const options = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(options)) return unionOf(options.map((one) => typeOf(one, writing, depth)));
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return typeOf(schema.allOf[0], writing, depth);
  }
  const { type } = schema;
  if (Array.isArray(type)) {
    return unionOf(type.map((one) => typeOf({ ...schema, type: one }, writing, depth)));
  }
  switch (type) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array":
      return "items" in schema ? `list[${typeOf(schema.items, writing, depth)}]` : "list";
    case "object":
    case undefined:
      break;
    default:
      return "Any";
  }
  const properties = isSchema(schema.properties) ? Object.entries(schema.properties) : [];
  if (properties.length > 0 && depth > 0) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = properties.map(
      ([key, value]) =>
        `${key}${required.has(key) ? "" : "?"}: ${typeOf(value, writing, depth - 1)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  if (isSchema(schema.additionalProperties) && Object.keys(schema.additionalProperties).length) {
    return `dict[str, ${typeOf(schema.additionalProperties, writing, depth)}]`;
  }
  return type === "object" || properties.length > 0 ? "dict" : "Any";
}

// Whether the schema takes null.
export function takesNull(schema: unknown): boolean {
  if (!isSchema(schema)) return schema === true;
  if (Object.keys(schema).length === 0) return true;
  if ("const" in schema) return schema.const === null;
  if (Array.isArray(schema.enum)) return schema.enum.includes(null);
  const options = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(options)) return options.some(takesNull);
  const { type } = schema;
  return type === "null" || (Array.isArray(type) && type.includes("null"));
}

function defsOf(schema: Schema | undefined): Schema {
  if (!schema) return {};
  return {
    ...(isSchema(schema.definitions) ? schema.definitions : {}),
    ...(isSchema(schema.$defs) ? schema.$defs : {}),
  };
}

// What the function takes, by name: required ones first, as the schema orders them.
export function parametersOf(inputSchema: Schema) {
  const properties = isSchema(inputSchema.properties) ? inputSchema.properties : {};
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const names = Object.keys(properties);
  const extra = inputSchema.additionalProperties;
  const choices = Object.keys(TOP_LEVEL_CHOICES).some((key) => key in inputSchema);
  return {
    properties,
    required,
    ordered: [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))],
    // Whether it says it takes keywords beyond those named, or names none and sets no choice.
    open:
      extra === true ||
      isSchema(extra) ||
      (!("properties" in inputSchema) && !choices && extra !== false),
    // Whether it refuses keywords it does not name.
    closed: extra === false,
  };
}

// How a signature is written: how deep objects are spelled out, whether values to choose from are
// only their type, and how many parameters are shown before `...`.
interface Shape {
  depth: number;
  short: boolean;
  most: number;
}

const FULL: Shape = { depth: DEPTH, short: false, most: Infinity };

// The tool as a Python function's signature, on one line, with any choice between whole inputs
// after it.
export function signatureOf(name: string, schemas: ToolSchemas, shape: Shape = FULL) {
  const { inputSchema, outputSchema } = schemas;
  const writing = { defs: defsOf(inputSchema), short: shape.short };
  const { properties, required, ordered, open } = parametersOf(inputSchema);
  const params = ordered
    .slice(0, shape.most)
    .map(
      (key) =>
        `${key}: ${typeOf(properties[key], writing, shape.depth - 1)}${required.has(key) ? "" : " = None"}`,
    );
  if (ordered.length > shape.most) params.push("...");
  else if (open) params.push("**kwargs: Any");
  const result = outputSchema
    ? ` -> ${typeOf(outputSchema, { defs: defsOf(outputSchema), short: shape.short }, shape.depth)}`
    : "";
  const choice = choiceInWords(inputSchema);
  return `${name}(${params.join(", ")})${result}${choice ? `  # ${choice}` : ""}`;
}

// The most characters of one tool's signature in the model's list.
export const LINE_CHARS = 300;

// The signature as the model's list gives it: in full where it fits, else shorter, by objects
// written only as `dict`, values to choose from as their type, then fewer parameters.
export function listedSignature(name: string, schemas: ToolSchemas) {
  const shapes: Shape[] = [
    FULL,
    { depth: 1, short: false, most: Infinity },
    { depth: 1, short: true, most: Infinity },
  ];
  for (const shape of shapes) {
    const line = signatureOf(name, schemas, shape);
    if (line.length <= LINE_CHARS) return line;
  }
  for (let most = parametersOf(schemas.inputSchema).ordered.length - 1; most > 0; most -= 1) {
    const line = signatureOf(name, schemas, { depth: 1, short: true, most });
    if (line.length <= LINE_CHARS) return line;
  }
  const line = signatureOf(name, schemas, { depth: 0, short: true, most: 0 });
  return line.length <= LINE_CHARS ? line : `${name}(...)`;
}

// The signatures, one a line, as many as fit in the characters, then how many others there are,
// by name where their names fit too.
export function signaturesText(
  lines: readonly { name: string; signature: string }[],
  chars: number,
) {
  const shown: string[] = [];
  // Room kept for the line that counts the rest.
  const counted = (n: number) => `+${n} more (list_tools())`;
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const left = lines.length - index - 1;
    const room = left > 0 ? counted(left).length + 1 : 0;
    if (used + line.signature.length + 1 + room > chars) break;
    shown.push(line.signature);
    used += line.signature.length + 1;
  }
  const rest = lines.slice(shown.length);
  if (rest.length > 0) {
    const named = `+${rest.length} more: ${rest.map((line) => line.name).join(", ")} (list_tools())`;
    shown.push(used + named.length <= chars ? named : counted(rest.length));
  }
  return shown.join("\n");
}

function distance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

// The names nearest the one given, nearest first: those holding it, then those spelled nearly so.
export function closest(name: string, names: readonly string[], most = 3) {
  const wanted = name.toLowerCase();
  const near = Math.max(2, Math.ceil(wanted.length * 0.2));
  return names
    .map((one) => {
      const lower = one.toLowerCase();
      const holds = lower.includes(wanted) || wanted.includes(lower);
      return {
        one,
        score: holds ? Math.abs(lower.length - wanted.length) / 100 : distance(wanted, lower),
      };
    })
    .filter(({ score }) => score < 1 || score <= near)
    .sort((a, b) => a.score - b.score || a.one.localeCompare(b.one))
    .slice(0, most)
    .map(({ one }) => one);
}
