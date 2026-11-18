import { describe, expect, it } from "vite-plus/test";

import {
  closest,
  functionNames,
  LINE_CHARS,
  listedSignature,
  signatureOf,
  signaturesText,
  takesNull,
} from "./signatures.ts";

describe("a tool's Python signature", () => {
  it("gives each parameter its type from the schema, required ones first, optional ones = None", () => {
    expect(
      signatureOf("exa__web_search", {
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            query: { type: "string" },
            score: { type: "number" },
            exact: { type: "boolean" },
            tags: { type: "array", items: { type: "string" } },
            mode: { enum: ["fast", "deep"] },
            since: { anyOf: [{ type: "string" }, { type: "null" }] },
            filter: {
              type: "object",
              properties: { site: { type: "string" }, n: { type: "integer" } },
              required: ["site"],
            },
            extra: { type: "object", additionalProperties: { type: "number" } },
            anything: {},
          },
          required: ["query", "tags"],
        },
      }),
    ).toBe(
      'exa__web_search(query: str, tags: list[str], limit: int = None, score: float = None, exact: bool = None, mode: Literal["fast", "deep"] = None, since: str | None = None, filter: {site: str, n?: int} = None, extra: dict[str, float] = None, anything: Any = None)',
    );
  });

  it("gives the result type only where the tool declares what it gives back", () => {
    const inputSchema = { type: "object", properties: { id: { type: "string" } } };
    expect(signatureOf("a__get", { inputSchema })).toBe("a__get(id: str = None)");
    expect(
      signatureOf("a__get", {
        inputSchema,
        outputSchema: {
          type: "object",
          properties: { items: { type: "array", items: { $ref: "#/$defs/Item" } } },
          required: ["items"],
          $defs: { Item: { type: "object", properties: { n: { type: "integer" } } } },
        },
      }),
    ).toBe("a__get(id: str = None) -> {items: list[{n?: int}]}");
  });

  it("takes no parameters where the schema has none, and any keywords where it allows any", () => {
    expect(signatureOf("a__now", { inputSchema: { type: "object", properties: {} } })).toBe(
      "a__now()",
    );
    expect(
      signatureOf("a__put", { inputSchema: { type: "object", additionalProperties: {} } }),
    ).toBe("a__put(**kwargs: Any)");
  });

  it("is a Python name however the tool is named for the model, distinct for each tool", () => {
    const names = functionNames(["my-server__get-item", "9lives__x", "a__get-item", "a__get_item"]);
    expect(names.get("my-server__get-item")).toBe("my_server__get_item");
    expect(names.get("9lives__x")).toBe("_9lives__x");
    // The one already a Python name keeps it; the one changed into it ends in a hash of its own.
    expect(names.get("a__get_item")).toBe("a__get_item");
    expect(names.get("a__get-item")).toMatch(/^a__get_item_[0-9a-f]{6}$/);
    expect(new Set(names.values()).size).toBe(4);
    // The same whatever order the tools come in.
    expect(functionNames(["a__get_item", "a__get-item"]).get("a__get-item")).toBe(
      names.get("a__get-item"),
    );
  });

  it("writes a choice between whole inputs in words after it, taking no other keywords", () => {
    expect(
      signatureOf("a__find", {
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          oneOf: [{ required: ["a"] }, { required: ["b"] }],
        },
      }),
    ).toBe(
      "a__find(a: str = None, b: str = None)  # Input constraint: Provide parameters for exactly one of: (a) or (b).",
    );
    expect(signatureOf("a__find", { inputSchema: { anyOf: [{ required: ["a"] }] } })).not.toContain(
      "**kwargs",
    );
  });

  it("is cut to fit a line in the model's list however many its values and parameters", () => {
    const values = Array.from({ length: 200 }, (_, i) => `value_${i}`);
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`param_${i}`, { type: "string" }]),
    );
    const enums = { inputSchema: { type: "object", properties: { kind: { enum: values } } } };
    const wide = { inputSchema: { type: "object", properties: many, required: ["param_0"] } };
    expect(listedSignature("a__kind", enums)).toBe("a__kind(kind: str = None)");
    const cut = listedSignature("a__wide", wide);
    expect(cut.length).toBeLessThanOrEqual(LINE_CHARS);
    expect(cut).toMatch(/^a__wide\(param_0: str, .*, \.\.\.\)$/);
    // In full where asked for one alone.
    expect(signatureOf("a__kind", enums)).toContain('"value_199"');
  });

  it("knows which schemas take null", () => {
    expect(takesNull({ type: ["string", "null"] })).toBe(true);
    expect(takesNull({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(true);
    expect(takesNull({})).toBe(true);
    expect(takesNull({ type: "string" })).toBe(false);
    expect(takesNull({ enum: ["a"] })).toBe(false);
  });
});

describe("the signatures the model reads", () => {
  const lines = Array.from({ length: 6 }, (_, i) => ({
    name: `t__tool${i}`,
    signature: `t__tool${i}(a: str)`,
  }));

  it("lists every signature that fits, one a line, then names or counts the rest, within its size", () => {
    for (const chars of [40, 60, 90, 120]) {
      const text = signaturesText(lines, chars);
      expect(text.length).toBeLessThanOrEqual(chars);
      const shown = text.split("\n").filter((line) => line.endsWith(")") && !line.startsWith("+"));
      const rest = lines.length - shown.length;
      expect(text.endsWith(`(list_tools())`)).toBe(rest > 0);
      if (rest > 0) expect(text).toContain(`+${rest} more`);
    }
    const long = lines.map((line) => ({
      ...line,
      signature: `${line.name}(${"a".repeat(40)}: str)`,
    }));
    expect(signaturesText(long, 180).split("\n").slice(2)).toEqual([
      "+4 more: t__tool2, t__tool3, t__tool4, t__tool5 (list_tools())",
    ]);
    expect(signaturesText(lines, 60)).toBe(
      ["t__tool0(a: str)", "t__tool1(a: str)", "+4 more (list_tools())"].join("\n"),
    );
  });

  it("is the same text for the same tools", () => {
    expect(signaturesText(lines, 60)).toBe(signaturesText([...lines], 60));
    expect(signaturesText(lines, 10_000).split("\n")).toHaveLength(6);
  });
});

describe("the names closest to one not found", () => {
  const names = ["exa__web_search", "exa__web_fetch", "notes__write", "notes__read"];

  it("are those spelled nearly so, or holding it, nearest first", () => {
    expect(closest("exa__web_serch", names)).toEqual(["exa__web_search", "exa__web_fetch"]);
    expect(closest("web_search", names)[0]).toBe("exa__web_search");
    expect(closest("notes__writ", names)).toEqual(["notes__write"]);
  });

  it("are none where nothing is near", () => {
    expect(closest("total", names)).toEqual([]);
    expect(closest("probe__wiat", ["jobs__list", "probe__wait", "probe__guarded_wait"])).toEqual([
      "probe__wait",
    ]);
  });
});
