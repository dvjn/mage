// What a thread's activity shows each reader: the tray of its background work and the parts of
// its tool rows that depend on the reader, for an owner, a member who may not decide and a guest.
// One thread holds every kind: a call waiting for a decision, jobs running, waiting and ended,
// timers, schedules and a webhook, subagents working, idle and archived, a skill loaded and a
// message sent to a subagent. Everything is arranged and read through the API and through what
// the model is sent.

import { describe, it } from "vite-plus/test";

import { answered, busyThread } from "@/server/testing/busy-thread.ts";
import { eventually, expect, type Person, type World, world } from "@/server/testing/contract.ts";

// Ids as they first appear, numbered, so what is read compares whatever ids the run made.
function stable(value: unknown) {
  const seen = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll(/\/api\/hooks\/[\w-]+/g, "/api/hooks/<token>")
      .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, (id) => {
        if (!seen.has(id)) seen.set(id, `<id ${seen.size + 1}>`);
        return seen.get(id)!;
      }),
  ) as unknown;
}

async function tray(w: World, who: Person) {
  return stable(
    (await w.activity(who)).map((item) => ({
      rowId: item.rowId,
      title: item.title,
      kind: item.work.kind,
      status: item.work.status,
      canDecide: item.work.canDecide ?? null,
      canCancel: item.work.canCancel,
      attention: item.attention ?? null,
      by: item.by ?? null,
    })),
  );
}

async function cards(w: World, who: Person) {
  return stable(
    (await w.activity(who)).flatMap((item): Record<string, unknown>[] => {
      const { schedule, webhook, subagent } = item.work;
      if (schedule) {
        return [
          {
            title: item.title,
            fired: schedule.fired,
            canChange: schedule.canChange,
            nextRunAt: schedule.nextRunAt !== undefined,
          },
        ];
      }
      if (webhook) {
        return [
          {
            title: item.title,
            fired: webhook.fired,
            canChange: webhook.canChange,
            path: webhook.path !== undefined,
          },
        ];
      }
      if (subagent) {
        return [
          {
            title: item.title,
            state: subagent.state,
            needs: subagent.needs ?? null,
            tasks: subagent.tasks ?? null,
            waitingRow: subagent.waitingRow ?? null,
            canCancel: item.work.canCancel,
          },
        ];
      }
      return [];
    }),
  );
}

// The reader's parts of the thread's tool rows.
async function rows(w: World, who: Person) {
  const detail = await w.detail(who);
  const times = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, field: unknown) => (key.endsWith("At") ? "<time>" : field)),
    ) as unknown;
  // Only the parts the row has.
  const present = (value: Record<string, unknown>) =>
    times(Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null)));
  return stable(
    detail.rows.flatMap((row) =>
      row.kind === "tool"
        ? [
            present({
              id: row.id,
              toolId: row.toolId,
              background: row.work ?? null,
              subagent: row.subagent ?? null,
              subagentCall: row.subagentCall
                ? {
                    id: row.subagentCall.id,
                    toolId: row.subagentCall.toolId,
                    actions: row.subagentCall.actions ?? null,
                  }
                : null,
              effects: row.effects ?? null,
              skill: row.skill ?? null,
              subagentName: row.subagentName ?? null,
              model: row.model ?? null,
              canBackground: row.canBackground ?? null,
              actions: row.actions ?? null,
              canAnswer: row.canAnswer ?? null,
            }),
          ]
        : [],
    ),
  );
}

// What each reader is shown, read once from the arrangement below.
const OWNER = {
  tray: [
    {
      rowId: "call-2",
      title: "Check in",
      kind: "schedule",
      status: "scheduled",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-3",
      title: "Digest",
      kind: "schedule",
      status: "scheduled",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-4",
      title: "Weekly",
      kind: "schedule",
      status: "paused",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "<id 1>",
      title: "Wait",
      kind: "job",
      status: "running",
      canDecide: null,
      canCancel: true,
      attention: null,
      by: "Ada Lovelace",
    },
    {
      rowId: "<id 2>",
      title: "Guarded",
      kind: "decision",
      status: "waiting",
      canDecide: true,
      canCancel: false,
      attention: "approval",
      by: null,
    },
    {
      rowId: "<id 2>",
      title: "Guarded",
      kind: "job",
      status: "waiting",
      canDecide: true,
      canCancel: true,
      attention: "approval",
      by: "Ada Lovelace",
    },
    {
      rowId: "call-13",
      title: "Deploys",
      kind: "webhook",
      status: "listening",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-16",
      title: "Guarded",
      kind: "decision",
      status: "waiting",
      canDecide: true,
      canCancel: false,
      attention: "approval",
      by: null,
    },
    {
      rowId: "<id 3>",
      title: "Worker",
      kind: "subagent",
      status: "waiting",
      canDecide: true,
      canCancel: true,
      attention: "approval",
      by: null,
    },
    {
      rowId: "<id 4>",
      title: "Idle",
      kind: "subagent",
      status: "idle",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
  ],
  cards: [
    {
      title: "Check in",
      fired: 0,
      canChange: true,
      nextRunAt: true,
    },
    {
      title: "Digest",
      fired: 0,
      canChange: true,
      nextRunAt: true,
    },
    {
      title: "Weekly",
      fired: 0,
      canChange: true,
      nextRunAt: false,
    },
    {
      title: "Deploys",
      fired: 0,
      canChange: true,
      path: true,
    },
    {
      title: "Worker",
      state: "working",
      needs: "decision",
      tasks: null,
      waitingRow: "call-12",
      canCancel: true,
    },
    {
      title: "Idle",
      state: "idle",
      needs: null,
      tasks: {
        done: 0,
        total: 1,
      },
      waitingRow: null,
      canCancel: false,
    },
  ],
  rows: [
    {
      id: "call-1",
      toolId: "tasks.add",
    },
    {
      id: "call-2",
      toolId: "schedules.wake_at",
      background: {
        kind: "schedule",
        status: "scheduled",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 1>",
          kind: "once",
          name: "Check in",
          nextRunAt: "<time>",
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-3",
      toolId: "schedules.add",
      background: {
        kind: "schedule",
        status: "scheduled",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 2>",
          kind: "cron",
          name: "Digest",
          cron: "0 9 * * *",
          words: "Every day at 09:00",
          timezone: "UTC",
          nextRunAt: "<time>",
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-4",
      toolId: "schedules.add",
      background: {
        kind: "schedule",
        status: "paused",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 3>",
          kind: "cron",
          name: "Weekly",
          cron: "0 9 * * 1",
          words: "Every Monday at 09:00",
          timezone: "UTC",
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-5",
      toolId: "jobs.start",
    },
    {
      id: "call-6",
      toolId: "jobs.start",
    },
    {
      id: "call-7",
      toolId: "jobs.start",
    },
    {
      id: "call-8",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 4>",
        name: "Worker",
        state: "working",
        needs: "decision",
      },
      subagentCall: {
        id: "call-12",
        toolId: "probe.guarded",
        actions: ["allow", "deny"],
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 4>",
          rowId: "<id 5>",
          name: "Worker",
        },
      ],
      subagentName: "Worker",
    },
    {
      id: "call-9",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 6>",
        name: "Idle",
        state: "idle",
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 6>",
          rowId: "<id 7>",
          name: "Idle",
        },
      ],
      subagentName: "Idle",
    },
    {
      id: "call-10",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 8>",
        name: "Gone",
        state: "archived",
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 8>",
          rowId: "<id 9>",
          name: "Gone",
        },
      ],
      subagentName: "Gone",
    },
    {
      id: "call-11",
      toolId: "skills.load",
      skill: "page-design",
    },
    {
      id: "<id 10>",
      toolId: "probe.wait",
      background: {
        kind: "job",
        status: "running",
        startedAt: "<time>",
        canCancel: true,
      },
    },
    {
      id: "<id 11>",
      toolId: "probe.guarded",
      background: {
        kind: "job",
        status: "waiting",
        startedAt: "<time>",
        canCancel: true,
      },
      actions: ["allow", "deny"],
    },
    {
      id: "<id 12>",
      toolId: "probe.wait",
      background: {
        kind: "job",
        status: "completed",
        startedAt: "<time>",
        endedAt: "<time>",
        canCancel: false,
      },
    },
    {
      id: "call-13",
      toolId: "webhooks.add",
      background: {
        kind: "webhook",
        status: "listening",
        startedAt: "<time>",
        canCancel: false,
        webhook: {
          id: "<id 13>",
          name: "Deploys",
          path: "/api/hooks/<token>",
          signed: false,
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-14",
      toolId: "subagents.archive",
      effects: [
        {
          kind: "thread",
          threadId: "<id 8>",
          name: "Gone",
        },
      ],
    },
    {
      id: "call-15",
      toolId: "subagents.send",
      effects: [
        {
          kind: "message",
          threadId: "<id 6>",
          rowId: "<id 14>",
          name: "Idle",
        },
      ],
    },
    {
      id: "call-16",
      toolId: "probe.guarded",
      canBackground: true,
      actions: ["allow", "deny"],
    },
  ],
  run: "decision",
};

const VIEWER = {
  tray: [
    {
      rowId: "call-2",
      title: "Check in",
      kind: "schedule",
      status: "scheduled",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-3",
      title: "Digest",
      kind: "schedule",
      status: "scheduled",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-4",
      title: "Weekly",
      kind: "schedule",
      status: "paused",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "<id 1>",
      title: "Wait",
      kind: "job",
      status: "running",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: "Ada Lovelace",
    },
    {
      rowId: "<id 2>",
      title: "Guarded",
      kind: "decision",
      status: "waiting",
      canDecide: false,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "<id 2>",
      title: "Guarded",
      kind: "job",
      status: "waiting",
      canDecide: false,
      canCancel: false,
      attention: null,
      by: "Ada Lovelace",
    },
    {
      rowId: "call-13",
      title: "Deploys",
      kind: "webhook",
      status: "listening",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-16",
      title: "Guarded",
      kind: "decision",
      status: "waiting",
      canDecide: false,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "<id 3>",
      title: "Worker",
      kind: "subagent",
      status: "waiting",
      canDecide: false,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "<id 4>",
      title: "Idle",
      kind: "subagent",
      status: "idle",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
  ],
  cards: [
    {
      title: "Check in",
      fired: 0,
      canChange: false,
      nextRunAt: true,
    },
    {
      title: "Digest",
      fired: 0,
      canChange: false,
      nextRunAt: true,
    },
    {
      title: "Weekly",
      fired: 0,
      canChange: false,
      nextRunAt: false,
    },
    {
      title: "Deploys",
      fired: 0,
      canChange: false,
      path: false,
    },
    {
      title: "Worker",
      state: "working",
      needs: "decision",
      tasks: null,
      waitingRow: "call-12",
      canCancel: false,
    },
    {
      title: "Idle",
      state: "idle",
      needs: null,
      tasks: {
        done: 0,
        total: 1,
      },
      waitingRow: null,
      canCancel: false,
    },
  ],
  rows: [
    {
      id: "call-1",
      toolId: "tasks.add",
    },
    {
      id: "call-2",
      toolId: "schedules.wake_at",
      background: {
        kind: "schedule",
        status: "scheduled",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 1>",
          kind: "once",
          name: "Check in",
          nextRunAt: "<time>",
          fired: 0,
          canChange: false,
        },
      },
    },
    {
      id: "call-3",
      toolId: "schedules.add",
      background: {
        kind: "schedule",
        status: "scheduled",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 2>",
          kind: "cron",
          name: "Digest",
          cron: "0 9 * * *",
          words: "Every day at 09:00",
          timezone: "UTC",
          nextRunAt: "<time>",
          fired: 0,
          canChange: false,
        },
      },
    },
    {
      id: "call-4",
      toolId: "schedules.add",
      background: {
        kind: "schedule",
        status: "paused",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 3>",
          kind: "cron",
          name: "Weekly",
          cron: "0 9 * * 1",
          words: "Every Monday at 09:00",
          timezone: "UTC",
          fired: 0,
          canChange: false,
        },
      },
    },
    {
      id: "call-5",
      toolId: "jobs.start",
    },
    {
      id: "call-6",
      toolId: "jobs.start",
    },
    {
      id: "call-7",
      toolId: "jobs.start",
    },
    {
      id: "call-8",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 4>",
        name: "Worker",
        state: "working",
        needs: "decision",
      },
      subagentCall: {
        id: "call-12",
        toolId: "probe.guarded",
        actions: [],
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 4>",
          rowId: "<id 5>",
          name: "Worker",
        },
      ],
      subagentName: "Worker",
    },
    {
      id: "call-9",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 6>",
        name: "Idle",
        state: "idle",
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 6>",
          rowId: "<id 7>",
          name: "Idle",
        },
      ],
      subagentName: "Idle",
    },
    {
      id: "call-10",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 8>",
        name: "Gone",
        state: "archived",
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 8>",
          rowId: "<id 9>",
          name: "Gone",
        },
      ],
      subagentName: "Gone",
    },
    {
      id: "call-11",
      toolId: "skills.load",
      skill: "page-design",
    },
    {
      id: "<id 10>",
      toolId: "probe.wait",
      background: {
        kind: "job",
        status: "running",
        startedAt: "<time>",
        canCancel: false,
      },
    },
    {
      id: "<id 11>",
      toolId: "probe.guarded",
      background: {
        kind: "job",
        status: "waiting",
        startedAt: "<time>",
        canCancel: false,
      },
      actions: [],
    },
    {
      id: "<id 12>",
      toolId: "probe.wait",
      background: {
        kind: "job",
        status: "completed",
        startedAt: "<time>",
        endedAt: "<time>",
        canCancel: false,
      },
    },
    {
      id: "call-13",
      toolId: "webhooks.add",
      background: {
        kind: "webhook",
        status: "listening",
        startedAt: "<time>",
        canCancel: false,
        webhook: {
          id: "<id 13>",
          name: "Deploys",
          signed: false,
          fired: 0,
          canChange: false,
        },
      },
    },
    {
      id: "call-14",
      toolId: "subagents.archive",
      effects: [
        {
          kind: "thread",
          threadId: "<id 8>",
          name: "Gone",
        },
      ],
    },
    {
      id: "call-15",
      toolId: "subagents.send",
      effects: [
        {
          kind: "message",
          threadId: "<id 6>",
          rowId: "<id 14>",
          name: "Idle",
        },
      ],
    },
    {
      id: "call-16",
      toolId: "probe.guarded",
      actions: [],
    },
  ],
  run: "decision",
};

const GUEST = {
  tray: [
    {
      rowId: "call-2",
      title: "Check in",
      kind: "schedule",
      status: "scheduled",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-3",
      title: "Digest",
      kind: "schedule",
      status: "scheduled",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-4",
      title: "Weekly",
      kind: "schedule",
      status: "paused",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "<id 1>",
      title: "Wait",
      kind: "job",
      status: "running",
      canDecide: null,
      canCancel: true,
      attention: null,
      by: "Ada Lovelace",
    },
    {
      rowId: "<id 2>",
      title: "Guarded",
      kind: "decision",
      status: "waiting",
      canDecide: true,
      canCancel: false,
      attention: "approval",
      by: null,
    },
    {
      rowId: "<id 2>",
      title: "Guarded",
      kind: "job",
      status: "waiting",
      canDecide: true,
      canCancel: true,
      attention: "approval",
      by: "Ada Lovelace",
    },
    {
      rowId: "call-13",
      title: "Deploys",
      kind: "webhook",
      status: "listening",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
    {
      rowId: "call-16",
      title: "Guarded",
      kind: "decision",
      status: "waiting",
      canDecide: true,
      canCancel: false,
      attention: "approval",
      by: null,
    },
    {
      rowId: "<id 3>",
      title: "Worker",
      kind: "subagent",
      status: "waiting",
      canDecide: true,
      canCancel: true,
      attention: "approval",
      by: null,
    },
    {
      rowId: "<id 4>",
      title: "Idle",
      kind: "subagent",
      status: "idle",
      canDecide: null,
      canCancel: false,
      attention: null,
      by: null,
    },
  ],
  cards: [
    {
      title: "Check in",
      fired: 0,
      canChange: true,
      nextRunAt: true,
    },
    {
      title: "Digest",
      fired: 0,
      canChange: true,
      nextRunAt: true,
    },
    {
      title: "Weekly",
      fired: 0,
      canChange: true,
      nextRunAt: false,
    },
    {
      title: "Deploys",
      fired: 0,
      canChange: true,
      path: true,
    },
    {
      title: "Worker",
      state: "working",
      needs: "decision",
      tasks: null,
      waitingRow: "call-12",
      canCancel: true,
    },
    {
      title: "Idle",
      state: "idle",
      needs: null,
      tasks: {
        done: 0,
        total: 1,
      },
      waitingRow: null,
      canCancel: false,
    },
  ],
  rows: [
    {
      id: "call-1",
      toolId: "tasks.add",
    },
    {
      id: "call-2",
      toolId: "schedules.wake_at",
      background: {
        kind: "schedule",
        status: "scheduled",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 1>",
          kind: "once",
          name: "Check in",
          nextRunAt: "<time>",
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-3",
      toolId: "schedules.add",
      background: {
        kind: "schedule",
        status: "scheduled",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 2>",
          kind: "cron",
          name: "Digest",
          cron: "0 9 * * *",
          words: "Every day at 09:00",
          timezone: "UTC",
          nextRunAt: "<time>",
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-4",
      toolId: "schedules.add",
      background: {
        kind: "schedule",
        status: "paused",
        startedAt: "<time>",
        canCancel: false,
        schedule: {
          id: "<id 3>",
          kind: "cron",
          name: "Weekly",
          cron: "0 9 * * 1",
          words: "Every Monday at 09:00",
          timezone: "UTC",
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-5",
      toolId: "jobs.start",
    },
    {
      id: "call-6",
      toolId: "jobs.start",
    },
    {
      id: "call-7",
      toolId: "jobs.start",
    },
    {
      id: "call-8",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 4>",
        name: "Worker",
        state: "working",
        needs: "decision",
      },
      subagentCall: {
        id: "call-12",
        toolId: "probe.guarded",
        actions: ["allow", "deny"],
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 4>",
          rowId: "<id 5>",
          name: "Worker",
        },
      ],
      subagentName: "Worker",
    },
    {
      id: "call-9",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 6>",
        name: "Idle",
        state: "idle",
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 6>",
          rowId: "<id 7>",
          name: "Idle",
        },
      ],
      subagentName: "Idle",
    },
    {
      id: "call-10",
      toolId: "subagents.start",
      subagent: {
        threadId: "<id 8>",
        name: "Gone",
        state: "archived",
      },
      effects: [
        {
          kind: "task",
          threadId: "<id 8>",
          rowId: "<id 9>",
          name: "Gone",
        },
      ],
      subagentName: "Gone",
    },
    {
      id: "call-11",
      toolId: "skills.load",
      skill: "page-design",
    },
    {
      id: "<id 10>",
      toolId: "probe.wait",
      background: {
        kind: "job",
        status: "running",
        startedAt: "<time>",
        canCancel: true,
      },
    },
    {
      id: "<id 11>",
      toolId: "probe.guarded",
      background: {
        kind: "job",
        status: "waiting",
        startedAt: "<time>",
        canCancel: true,
      },
      actions: ["allow", "deny"],
    },
    {
      id: "<id 12>",
      toolId: "probe.wait",
      background: {
        kind: "job",
        status: "completed",
        startedAt: "<time>",
        endedAt: "<time>",
        canCancel: false,
      },
    },
    {
      id: "call-13",
      toolId: "webhooks.add",
      background: {
        kind: "webhook",
        status: "listening",
        startedAt: "<time>",
        canCancel: false,
        webhook: {
          id: "<id 13>",
          name: "Deploys",
          path: "/api/hooks/<token>",
          signed: false,
          fired: 0,
          canChange: true,
        },
      },
    },
    {
      id: "call-14",
      toolId: "subagents.archive",
      effects: [
        {
          kind: "thread",
          threadId: "<id 8>",
          name: "Gone",
        },
      ],
    },
    {
      id: "call-15",
      toolId: "subagents.send",
      effects: [
        {
          kind: "message",
          threadId: "<id 6>",
          rowId: "<id 14>",
          name: "Idle",
        },
      ],
    },
    {
      id: "call-16",
      toolId: "probe.guarded",
      canBackground: true,
      actions: ["allow", "deny"],
    },
  ],
  run: "decision",
};

describe("a thread's activity", () => {
  it("leaves out what ended once the reader has seen its kind", async () => {
    const w = await world();
    await w.post(w.ada, "Get help");
    await w.asks(w.threadId, ["subagents.start", { name: "Researcher", task: "Look into it" }]);
    await w.answers(w.threadId, "Started one.");
    const child = await w.subagentNamed("Researcher");
    await w.next(child);
    await w.post(w.ada, "Stop it");
    await w.asks(w.threadId, ["subagents.stop", { subagent: "Researcher" }]);
    await w.answers(w.threadId, "Stopped.");
    await answered(w);
    await w.settled();
    const states = async (who: Person) =>
      (await w.activity(who)).map((item) => `${item.title} ${item.work.status}`);
    expect(await states(w.ada)).toEqual(["Researcher cancelled"]);
    expect(await w.act(w.ada, "POST", "/activity/seen", { kind: "subagents" })).toBe(200);
    expect(await states(w.ada)).toEqual([]);
    expect(await states(w.grace)).toEqual(["Researcher cancelled"]);
  });

  it("shows each reader the same tray and rows", async () => {
    const { w, guest } = await busyThread();
    const read = async (who: Person) => ({
      tray: await tray(w, who),
      cards: await cards(w, who),
      rows: await rows(w, who),
      run: (await w.detail(who)).run?.waiting ?? null,
    });
    expect(await read(w.ada)).toEqual(OWNER);
    expect(await read(w.alan)).toEqual(VIEWER);
    expect(await read(guest)).toEqual(GUEST);
  });

  it("shows on the start row of a subagent waiting on a decision its call, as each reader may decide it", async () => {
    const w = await world();
    const guest = await w.guest("Hedy Lamarr", "hedy@example.com");
    await w.post(w.ada, "Get help");
    await w.asks(w.threadId, ["subagents.start", { name: "Helper", task: "Help" }]);
    await w.answers(w.threadId, "Started.");
    const helper = await w.subagentNamed("Helper");
    const { ids } = await w.asks(helper, ["probe.guarded", { label: "sub" }]);
    await eventually(
      () => w.shown(w.ada, helper),
      (shown) => shown.run === "decision",
    );
    const below = async (who: Person) => {
      const start = (await w.detail(who)).rows.find(
        (row) => row.kind === "tool" && row.toolId === "subagents.start",
      );
      if (start?.kind !== "tool" || !start.subagentCall) return null;
      const { id, toolId, state, waitsFor, risk, actions, connection } = start.subagentCall;
      return {
        id,
        toolId,
        state,
        waitsFor,
        risk,
        actions: actions ?? null,
        connection: connection ?? null,
      };
    };
    const call = {
      id: ids[0],
      toolId: "probe.guarded",
      state: "waiting",
      waitsFor: "decision",
      risk: "ask",
    };
    expect(await below(w.ada)).toEqual({ ...call, actions: ["allow", "deny"], connection: null });
    expect(await below(w.alan)).toEqual({ ...call, actions: [], connection: null });
    expect(await below(guest)).toEqual({ ...call, actions: ["allow", "deny"], connection: null });

    expect(await w.decide(w.ada, ids[0]!, true, "once", helper)).toBe(200);
    await w.answers(helper, "Helped.");
    await eventually(
      () => w.shown(w.ada, helper),
      (shown) => shown.run === null,
    );
    await answered(w);
    await w.settled();
  });
});
