import { describe, expect, it } from "vite-plus/test";

import { connectionSlugs, slugOf } from "./aliases.ts";

function connection(
  id: string,
  host: "anthropic" | "codex" | "openrouter",
  label: string | null = null,
) {
  return { id, host, authKind: host === "codex" ? "oauth" : "api_key", label } as const;
}

describe("connection slugs", () => {
  it("are lower-case words joined by hyphens", () => {
    expect(slugOf("Work Codex")).toBe("work-codex");
    expect(slugOf("  Équipe / R&D  ")).toBe("equipe-r-d");
    expect(slugOf("···")).toBe("");
  });

  it("come from the name people gave a connection, or else its host's", () => {
    const slugs = connectionSlugs([
      connection("01A", "anthropic"),
      connection("01B", "openrouter", "Work Router"),
      connection("01C", "codex"),
    ]);

    expect([...slugs]).toEqual([
      ["01A", "anthropic"],
      ["01B", "work-router"],
      ["01C", "chatgpt"],
    ]);
  });

  it("number the later of connections that would share one", () => {
    const slugs = connectionSlugs([
      connection("01A", "anthropic"),
      connection("01B", "anthropic"),
      connection("01C", "openrouter", "Anthropic"),
    ]);

    expect([...slugs.values()]).toEqual(["anthropic", "anthropic-2", "anthropic-3"]);
  });

  it("fall back to the host for a name with nothing to keep", () => {
    expect(connectionSlugs([connection("01A", "openrouter", "···")]).get("01A")).toBe("openrouter");
  });

  it("leave a sign-in's host to the sign-in, as stored refs name it so", () => {
    const slugs = connectionSlugs([
      connection("01A", "openrouter", "Codex"),
      connection("01B", "codex"),
    ]);

    expect(slugs.get("01A")).toBe("codex-2");
    expect(slugs.get("01B")).toBe("chatgpt");
  });

  it("follow a rename", () => {
    const before = connectionSlugs([connection("01A", "openrouter", "Work")]);
    const after = connectionSlugs([connection("01A", "openrouter", "Research")]);

    expect([before.get("01A"), after.get("01A")]).toEqual(["work", "research"]);
  });
});
