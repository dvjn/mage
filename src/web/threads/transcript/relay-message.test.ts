import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RelayRow } from "@/shared/threads/rows.ts";
import { RelayMessages } from "@/web/threads/transcript/relay-message";
import { SubagentNotice } from "@/web/threads/transcript/subagent-notice";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    params,
    className,
  }: {
    children: import("react").ReactNode;
    params: { threadId: string };
    className?: string;
  }) => createElement("a", { href: `/t/${params.threadId}`, className }, children),
}));

function message(main = false): RelayRow {
  return {
    kind: "relay",
    id: "incoming",
    order: 1,
    seq: 2,
    turn: null,
    postedAt: "2026-11-10T00:00:00.000Z",
    type: "message",
    from: { threadId: "sender", name: main ? "Main thread" : "Reviewer", main },
    to: main ? "Reviewer" : "agent",
    text: "Review complete",
  };
}

const render = (rows: RelayRow[]) =>
  renderToStaticMarkup(
    createElement(RelayMessages, {
      rows,
      opened: new Set<string>(),
      onOpenChange: () => {},
    }),
  );

describe("top-level incoming activity", () => {
  it("names the sender with a left avatar for messages in either direction", () => {
    for (const main of [false, true]) {
      const html = render([message(main)]);
      expect(html).toContain(`aria-label="Message from ${main ? "Agent" : "Reviewer"}"`);
      expect(html).toContain('data-slot="avatar"');
      expect(html).not.toContain("pl-9");
      expect(html).toContain(main ? "Agent" : "Reviewer");
      // The message shows as a one-line title, its text behind the details button.
      expect(html).toContain("Message from");
      expect(html).toContain('aria-label="Show details"');
      expect(html).toContain(`aria-label="About ${main ? "Agent" : "Reviewer"}"`);
      expect(html).not.toContain("dateTime=");
    }
  });

  it("shows every consecutive message as its own readable bubble", () => {
    const html = render([message(), { ...message(), id: "second" }]);
    expect(html.match(/aria-label="Message from Reviewer"/g)).toHaveLength(2);
    expect(html).toContain('data-slot="avatar"');
    expect(html).not.toContain("pl-9");
  });

  it("shows received notifications at the top level without attributing them to an agent", () => {
    const html = render([{ ...message(), type: "agent.idle" }]);
    expect(html).toContain('aria-label="Notification"');
    expect(html).toContain('data-slot="avatar"');
    expect(html).not.toContain("pl-9");
    const notice = renderToStaticMarkup(
      createElement(SubagentNotice, {
        row: { kind: "notice", id: "notice", order: 2, seq: 3, turn: null, subagents: [] },
      }),
    );
    expect(notice).not.toContain("pl-9");
    expect(notice).toContain('data-slot="avatar"');
  });
});
