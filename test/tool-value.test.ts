import { describe, expect, it } from "vite-plus/test";

import { callResultOf, layoutOf } from "@/web/lib/tool-value.ts";

describe("laying out a tool's value", () => {
  it("shows plain values as they are", () => {
    expect(layoutOf("Looms")).toEqual({ kind: "text", text: "Looms" });
    expect(layoutOf(3)).toEqual({ kind: "number", value: 3 });
    expect(layoutOf(false)).toEqual({ kind: "boolean", value: false });
    expect(layoutOf(null)).toEqual({ kind: "none" });
    expect(layoutOf(["a", 1, null])).toEqual({ kind: "list", items: ["a", 1, null] });
  });

  it("labels fields by their schema in its order and keeps other keys after", () => {
    const schema = {
      type: "object",
      properties: {
        model: { type: "string", title: "Model" },
        effort: { anyOf: [{ type: "string" }, { type: "null" }], title: "Effort" },
      },
    };
    expect(layoutOf({ extra: 1, effort: null, model: "codex/gpt" }, schema)).toEqual({
      kind: "fields",
      fields: [
        {
          key: "model",
          label: "Model",
          value: { kind: "text", text: "codex/gpt" },
        },
        { key: "effort", label: "Effort", value: { kind: "none" } },
        { key: "extra", label: "extra", value: { kind: "number", value: 1 } },
      ],
    });
  });

  it("nests lists of objects, and shows the JSON past two levels", () => {
    expect(layoutOf({ people: [{ name: "Ada" }] })).toEqual({
      kind: "fields",
      fields: [
        {
          key: "people",
          label: "people",
          value: {
            kind: "items",
            items: [
              {
                kind: "fields",
                fields: [{ key: "name", label: "name", value: { kind: "text", text: "Ada" } }],
              },
            ],
          },
        },
      ],
    });
    const deep = { a: { b: { c: { d: 1 } } } };
    const a = layoutOf(deep);
    const b = a.kind === "fields" ? a.fields[0]!.value : null;
    const c = b?.kind === "fields" ? b.fields[0]!.value : null;
    expect(c?.kind === "fields" && c.fields[0]!.value).toEqual({
      kind: "json",
      json: JSON.stringify({ d: 1 }, null, 2),
    });
  });

  it("reads a call's output as MCP's result", () => {
    expect(callResultOf({ ok: true, value: { title: "Looms" } })).toEqual({
      content: [{ type: "text", text: '{"title":"Looms"}' }],
      structuredContent: { title: "Looms" },
    });
    expect(callResultOf({ ok: true, value: "done" })).toEqual({
      content: [{ type: "text", text: "done" }],
    });
    expect(callResultOf({ ok: false, error: "No folder" })).toEqual({
      content: [{ type: "text", text: "No folder" }],
      isError: true,
    });
  });
});
