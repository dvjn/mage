import { describe, expect, it } from "vite-plus/test";

import { countOf, entriesOf, layoutOf, outputLayoutOf } from "@/web/agent/tool-layout.ts";

describe("laying out a tool's value", () => {
  it("shows plain values as they are, and a list of them as chips", () => {
    expect(layoutOf("Looms")).toEqual({ kind: "text", text: "Looms" });
    expect(layoutOf(3)).toEqual({ kind: "number", value: 3 });
    expect(layoutOf(false)).toEqual({ kind: "boolean", value: false });
    expect(layoutOf(null)).toEqual({ kind: "none" });
    expect(layoutOf(["a", 1, null])).toEqual({ kind: "chips", items: ["a", 1, null] });
  });

  it("labels fields by their schema in its order and keeps other keys after", () => {
    const schema = {
      type: "object",
      properties: {
        model: { type: "string", title: "Model" },
        effort: { anyOf: [{ type: "string" }, { type: "null" }], title: "Effort" },
      },
    };
    const entries = entriesOf({ extra: 1, effort: null, model: "codex/gpt" }, schema);
    expect(entries.map(({ key, label, value }) => ({ key, label, value }))).toEqual([
      { key: "model", label: "Model", value: "codex/gpt" },
      { key: "effort", label: "Effort", value: null },
      { key: "extra", label: "extra", value: 1 },
    ]);
  });

  it("shows a list of objects as a table over the union of their keys", () => {
    const schema = {
      type: "array",
      items: { type: "object", properties: { name: { title: "Name" }, kind: { title: "Kind" } } },
    };
    const layout = layoutOf(
      [
        { owner: "payments", name: "api" },
        { kind: "Component", name: "ledger", tags: ["a"] },
      ],
      schema,
    );
    expect(layout.kind).toBe("table");
    if (layout.kind !== "table") return;
    expect(layout.columns.map(({ key, label }) => [key, label])).toEqual([
      ["name", "Name"],
      ["kind", "Kind"],
      ["owner", "owner"],
      ["tags", "tags"],
    ]);
    expect(layout.rows).toHaveLength(2);
  });

  it("shows an object as a tree, one level at a time", () => {
    const layout = layoutOf(
      { summary: { total: 7, mttr: { minutes: 42 } } },
      { properties: { summary: { title: "Summary", properties: { total: { title: "Total" } } } } },
    );
    expect(layout).toMatchObject({ kind: "tree", list: false, entries: [{ label: "Summary" }] });
    if (layout.kind !== "tree") return;
    const summary = layoutOf(layout.entries[0]!.value, layout.entries[0]!.schema);
    expect(summary).toMatchObject({
      kind: "tree",
      entries: [
        { label: "Total", value: 7 },
        { label: "mttr", value: { minutes: 42 } },
      ],
    });
  });

  it("shows a mixed list as a tree numbered from one", () => {
    expect(layoutOf([1, { a: 1 }])).toMatchObject({
      kind: "tree",
      list: true,
      entries: [
        { key: "0", label: "1", value: 1 },
        { key: "1", label: "2", value: { a: 1 } },
      ],
    });
  });

  it("counts what a nested value holds", () => {
    expect(countOf([1, 2, 3])).toBe("3 items");
    expect(countOf({ a: 1 })).toBe("1 field");
  });
});

describe("laying out a call's output", () => {
  it("shows why a call failed", () => {
    expect(outputLayoutOf({ ok: false, error: "No folder" })).toEqual({
      kind: "error",
      text: "No folder",
    });
  });

  it("shows text as Markdown, and JSON text as its value", () => {
    expect(outputLayoutOf({ ok: true, value: "# Notes\n\nDone." })).toEqual({
      kind: "markdown",
      text: "# Notes\n\nDone.",
    });
    expect(outputLayoutOf({ ok: true, value: ' [{"id":1}]' })).toMatchObject({
      kind: "value",
      layout: { kind: "table", rows: [{ id: 1 }] },
    });
    expect(outputLayoutOf({ ok: true, value: "{not json" })).toEqual({
      kind: "markdown",
      text: "{not json",
    });
    expect(outputLayoutOf({ ok: true, value: "42" })).toEqual({ kind: "markdown", text: "42" });
  });

  it("lays out structured content by its schema", () => {
    expect(
      outputLayoutOf(
        { ok: true, value: { words: 3 } },
        { properties: { words: { type: "number", title: "Words" } } },
      ),
    ).toMatchObject({ kind: "value", layout: { kind: "tree", entries: [{ label: "Words" }] } });
  });

  it("shows MCP's content parts one by one", () => {
    const layout = outputLayoutOf({
      ok: true,
      value: {
        content: [
          { type: "text", text: "p95 latency" },
          { type: "text", text: '{"total":2}' },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "resource_link", uri: "https://example.com/d/1", name: "Dashboard" },
          { type: "resource_link", uri: "javascript:alert(1)", name: "Script" },
          { type: "resource", resource: { uri: "notes://guide", text: "Keep notes short." } },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        ],
      },
    });
    expect(layout).toEqual({
      kind: "parts",
      parts: [
        { kind: "text", layout: { kind: "markdown", text: "p95 latency" } },
        {
          kind: "text",
          layout: {
            kind: "value",
            layout: {
              kind: "tree",
              list: false,
              entries: [{ key: "total", label: "total", value: 2, schema: undefined }],
            },
          },
        },
        { kind: "image", src: "data:image/png;base64,AAAA" },
        { kind: "link", label: "Dashboard", href: "https://example.com/d/1" },
        { kind: "link", label: "Script", href: undefined },
        { kind: "text", layout: { kind: "markdown", text: "Keep notes short." } },
        { kind: "other", label: "audio · audio/wav" },
      ],
    });
  });
});
