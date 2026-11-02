import { describe, expect, it } from "vite-plus/test";

import { closest, lineOf, parametersOf, rank, resolve } from "./tool-search.ts";
import type { DeferredTool } from "./tools.ts";

function tool(prefix: string, own: string, description: string, inputSchema = {}): DeferredTool {
  return {
    id: `${prefix}/${own}`,
    name: `${prefix}.${own}`,
    server: prefix.split(".")[1]!,
    prefix,
    description,
    inputSchema,
  };
}

const tools = [
  tool("mcp.notes", "add_note", "Write a note with a title and a body."),
  tool("mcp.notes", "delete_note", "Delete a note for good."),
  tool("mcp.github", "search_issues", "Search issues and pull requests by keyword."),
  tool("mcp.github", "create_issue", "Open a new issue in a repository."),
  tool("mcp.github", "list_commits", "List the commits of a branch."),
];

describe("searching", () => {
  it("ranks tools whose own names match first, then by server and description", () => {
    expect(rank(tools, "issue").map((found) => found.name)).toEqual([
      "mcp.github.create_issue",
      "mcp.github.search_issues",
    ]);
    expect(rank(tools, "delete note")[0]?.name).toBe("mcp.notes.delete_note");
    expect(rank(tools, "github commits")[0]?.name).toBe("mcp.github.list_commits");
    expect(rank(tools, "keyword").map((found) => found.name)).toEqual(["mcp.github.search_issues"]);
    expect(rank(tools, "mcp.notes.add_note")[0]?.name).toBe("mcp.notes.add_note");
    expect(rank(tools, "weather")).toEqual([]);
    expect(rank(tools, "note", 1)).toHaveLength(1);
  });

  it("selects tools by exact name, as providers spell it, or by their own name", () => {
    expect(resolve(tools, "mcp.notes.add_note")?.id).toBe("mcp.notes/add_note");
    expect(resolve(tools, "mcp__notes__add_note")?.id).toBe("mcp.notes/add_note");
    expect(resolve(tools, "MCP.Notes.Add_Note")?.id).toBe("mcp.notes/add_note");
    expect(resolve(tools, "create_issue")?.id).toBe("mcp.github/create_issue");
    expect(resolve(tools, "add_nte")).toBeNull();
  });

  it("suggests the closest names for one that matches none", () => {
    expect(closest(tools, "add_nte")).toEqual(["mcp.notes.add_note"]);
    expect(closest(tools, "mcp.github.create_issues")[0]).toBe("mcp.github.create_issue");
    expect(closest(tools, "something else entirely")).toEqual([]);
  });

  it("sums up what a tool takes and does in short", () => {
    expect(
      parametersOf({
        type: "object",
        properties: {
          title: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          state: { enum: ["open", "closed"] },
          count: { type: ["number", "null"] },
        },
        required: ["title"],
      }),
    ).toBe('title: string, tags?: string[], state?: "open" | "closed", count?: number | null');
    expect(lineOf("First line.\nMore detail.")).toBe("First line.");
    expect(lineOf("x".repeat(200))).toHaveLength(120);
  });
});
