import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRow } from "@/shared/threads/rows.ts";
import { AgentReply } from "@/web/threads/transcript/agent-reply";

function render(overrides: Partial<AgentRow> = {}) {
  const row: AgentRow = {
    kind: "agent",
    id: "thought",
    order: 0,
    seq: 1,
    runId: "run",
    model: null,
    turn: { continued: false, model: null },
    startedAt: "2026-11-10T00:00:00.000Z",
    text: "",
    reasoning: "Search the web before answering.",
    thoughtMs: 1000,
    status: "completed",
    usage: null,
    retried: false,
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AgentReply, { row, continued: row.turn?.continued ?? false }),
      ),
    );
  } finally {
    client.clear();
  }
}

describe("an agent turn's reply layout", () => {
  it("keeps a thinking-only step compact without reserving a message toolbar", () => {
    for (const continued of [false, true]) {
      const html = render({ turn: { continued, model: null } });
      expect(html).toContain("Thought for 1s");
      expect(html).not.toContain('aria-label="Message actions"');
      expect(html).not.toContain("h-6");
    }
  });

  it("keeps message actions with the answer", () => {
    const html = render({ text: "Here is the answer." });
    expect(html).toContain('aria-label="Message actions"');
    expect(html).toContain('aria-label="Copy"');
  });

  it("keeps actions on a failed reply even if it only thought", () => {
    expect(render({ status: "failed" })).toContain('aria-label="Message actions"');
  });

  it("does not treat whitespace as an answer or reserve actions while streaming", () => {
    expect(render({ text: " \n " })).not.toContain('aria-label="Message actions"');
    expect(render({ text: "Writing", status: "streaming" })).not.toContain(
      'aria-label="Message actions"',
    );
  });

  it("keeps existing thinking-only versions reachable", () => {
    expect(render({ versions: { at: 1, branches: ["first", "second"] } })).toContain(
      'aria-label="Versions"',
    );
  });
});
