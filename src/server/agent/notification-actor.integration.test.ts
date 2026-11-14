import { describe, expect, it } from "vite-plus/test";

import { agentThread } from "@/server/testing/agent-thread.ts";
import { eventSummary } from "@/server/threads/log.ts";
import { createTranscripts } from "@/server/threads/transcripts.ts";
import type { NotificationActor, NotificationKind } from "@/shared/threads/events.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { actorOf, createNotifier, type Notification, silentChange } from "./notifications.ts";

const source = { threadId: "worker", name: "Researcher", main: false };

function notice(kind: NotificationKind, actor?: NotificationActor): Notification {
  return { kind, source, text: "Something happened", people: [], ...(actor && { actor }) };
}

describe("notification actors", () => {
  it("are the sending agent for messages and reports", () => {
    for (const kind of ["message", "agent.ended", "agent.failed", "agent.stopped"] as const) {
      expect(actorOf(notice(kind))).toEqual({
        kind: "agent",
        threadId: "worker",
        name: "Researcher",
        main: false,
      });
    }
  });

  it("are left to the sender for the rest, which are no agent's words", () => {
    for (const kind of ["agent.idle", "call.ended", "trigger.fired", "webhook.received"] as const) {
      expect(actorOf(notice(kind))).toBeUndefined();
    }
    const hook = { kind: "source", label: "Self-test hook", type: "webhook" } as const;
    expect(actorOf(notice("webhook.received", hook))).toEqual(hook);
  });

  it("are the person for a quiet change they made", () => {
    const person = { kind: "person", userId: "u1", name: "Divya" } as const;
    expect(silentChange("t", "Divya", "Divya paused webhook X", "webhooks", person).actor).toEqual(
      person,
    );
    expect(silentChange("t", "Divya", "Divya paused webhook X").actor).toBeUndefined();
  });

  it("carry what a quiet change did, in parts, when told", () => {
    const change = {
      subject: { kind: "task", name: "Check Stripe" },
      action: "status",
      from: "doing",
      to: "todo",
    } as const;
    expect(silentChange("t", "Divya", "text", "tasks", undefined, change).change).toEqual(change);
    expect(silentChange("t", "Divya", "text").change).toBeUndefined();
  });

  it("are kept with the notification and shown on its row", async () => {
    const { threadStore, runStore, log, bus, thread } = await agentThread();
    const notifier = createNotifier({
      transcripts: createTranscripts(threadStore),
      runs: runStore,
      log,
      bus,
    });
    const person = { kind: "person", userId: "u1", name: "Divya" } as const;
    await notifier.send(
      thread.id,
      silentChange(thread.id, "Divya", "Divya paused it", "triggers", person),
    );
    await notifier.send(thread.id, { ...notice("message"), wake: false });
    await notifier.send(thread.id, {
      ...notice("trigger.fired", { kind: "source", label: "Nightly", type: "schedule" }),
      wake: false,
    });
    const rows = transcriptOf((await threadStore.eventsAfter(thread.id, 0)).map(eventSummary)).rows;
    const relays = rows.filter((row) => row.kind === "relay");
    expect(relays.map((row) => row.actor)).toEqual([
      person,
      { kind: "agent", threadId: "worker", name: "Researcher", main: false },
      { kind: "source", label: "Nightly", type: "schedule" },
    ]);
  });
});
