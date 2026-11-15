import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { NoticeRow } from "@/shared/threads/rows.ts";
import { Toaster } from "@/web/shell/toaster";
import { NoticeMessages } from "@/web/threads/transcript/notice-message";

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

function message(main = false): NoticeRow {
  return {
    kind: "notice",
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

const within = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { enabled: false } } }) },
      // A tool's card reports a failed connection as a toast.
      createElement(Toaster, null, element),
    ),
  );

const render = (rows: NoticeRow[]) =>
  within(
    createElement(NoticeMessages, {
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
      // The message is a card titled by its sender, open on its text.
      expect(html).toContain("Message from");
      expect(html).toContain("Review complete");
      expect(html).toContain('aria-label="Hide details"');
      expect(html).toContain(`aria-label="About ${main ? "Agent" : "Reviewer"}"`);
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
    expect(html).toContain('aria-label="Notice"');
    expect(html).toContain('data-slot="avatar"');
    expect(html).not.toContain("pl-9");
  });
});

describe("notification actors", () => {
  const change = (actor?: NoticeRow["actor"]): NoticeRow => ({
    kind: "notice",
    id: "changed",
    order: 1,
    seq: 2,
    turn: null,
    postedAt: "2026-11-10T00:00:00.000Z",
    type: "change",
    from: { threadId: "t", name: "Divya Jain", main: true },
    text: "Divya Jain paused webhook Self-test hook",
    ...(actor && { actor }),
  });

  it("show a person's avatar and name, and drop the name from the text", () => {
    const html = render([change({ kind: "person", userId: "u1", name: "Divya Jain" })]);
    expect(html).toContain("DJ");
    expect(html).toContain("paused webhook Self-test hook");
    expect(html).not.toContain("Divya Jain paused");
    expect(html).toContain("Divya Jain");
  });

  it("show an outside event as its kind of source, and keep older text as it was", () => {
    const hook = render([
      {
        ...change({ kind: "source", label: "Self-test hook", type: "webhook" }),
        text: "Webhook was posted to",
      },
    ]);
    expect(hook).toContain('aria-label="About Self-test hook"');
    expect(render([change()])).toContain("Divya Jain paused webhook Self-test hook");
  });

  it("show a change from its parts instead of its sentence", () => {
    const person = { kind: "person", userId: "u1", name: "Divya Jain" } as const;
    const task = (parts: NonNullable<NoticeRow["change"]>): NoticeRow => ({
      ...change(person),
      tray: "tasks",
      change: parts,
    });
    const status = render([
      task({
        subject: { kind: "task", name: "Check Stripe" },
        action: "status",
        from: "doing",
        to: "todo",
      }),
    ]);
    expect(status).toContain("Check Stripe");
    expect(status).toContain("To do");
    expect(status).not.toContain("marked task");
    const renamed = render([
      task({ subject: { kind: "task", name: "New" }, action: "rename", from: "Old", to: "New" }),
    ]);
    expect(renamed).toContain("Old");
    expect(renamed).toContain("New");
    const paused = render([
      {
        ...task({ subject: { kind: "schedule", name: "Digest" }, action: "pause" }),
        tray: "schedules",
      },
    ]);
    expect(paused).toContain("Digest");
    expect(paused).toContain("Paused");
    const signed = render([
      task({ subject: { kind: "webhook", name: "Hook" }, action: "signature", to: "on" }),
    ]);
    expect(signed).toContain("Signature on");
    const model = render([
      task({ subject: { kind: "thread", name: "T" }, action: "model", from: "a-1", to: "b-2" }),
    ]);
    expect(model).toContain("a-1");
    expect(model).toContain("b-2");
  });

  it("show a card header without the time", () => {
    expect(render([change()])).not.toContain("<time");
  });

  it("show an ended background call as the tool's card", () => {
    const row = {
      ...change(),
      type: "call.ended",
      text: "Call finished",
      ran: {
        kind: "tool",
        id: "call",
        order: 0,
        seq: 1,
        turn: null,
        toolId: "web.fetch",
        title: "Fetch",
        toolset: "Web",
        input: { url: "https://example.com" },
        output: { ok: true, value: "page" },
        state: "completed",
      },
    } as unknown as NoticeRow;
    const html = within(
      createElement(NoticeMessages, {
        rows: [row],
        opened: new Set([row.id]),
        onOpenChange: () => {},
      }),
    );
    expect(html).toContain("Done");
    expect(html).toContain("example.com");
  });
});
