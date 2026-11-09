// Mage's built-in Thread toolset, whose tools act on the thread the agent replies in: reading its
// details, renaming it, changing the model and effort it replies with, compacting what it reads of
// it, and asking its people questions. Each is cheap and
// shows in the thread. Asking is always on; the rest are actions orgs and spaces set. Changing the
// model asks first when the new one comes through another connection than the one replying now,
// since the whole thread then goes to another provider.

import * as z from "zod";

import type { GuestStore } from "@/server/guests/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Models, OpenModel } from "@/server/models/service.ts";
import type { SpaceStore } from "@/server/spaces/service.ts";
import { eventSummary } from "@/server/threads/log.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import { effortSchema } from "@/shared/threads/thread.ts";
import { transcriptOf } from "@/shared/transcript.ts";

import { askTool } from "./ask.ts";
import { compact as compactThread } from "./compaction.ts";
import type { Toolset, ToolSpec } from "./tools.ts";

export interface SystemToolsOptions {
  threads: Pick<ThreadStore, "find" | "update" | "eventsAfter">;
  spaceStore: Pick<SpaceStore, "find">;
  guests: Pick<GuestStore, "activeIn">;
  models: Pick<Models, "replyModel" | "requireModel">;
  // Opens the model a thread replies with, to write the summary that compacts it.
  open: (orgId: string, ref: string) => Promise<OpenModel>;
  now?: () => Date;
}

// How long writing a summary may take.
const COMPACT_TIMEOUT_MS = 5 * 60 * 1000;

// The connection part of a model ref.
function connectionOf(ref: string) {
  return ref.slice(0, ref.indexOf("/"));
}

export function createSystemTools(options: SystemToolsOptions): Toolset {
  const { threads, spaceStore, guests, models, open } = options;
  const now = options.now ?? (() => new Date());

  function threadOf(id: string) {
    const thread = threads.find(id);
    if (!thread) throw new Error("the thread is gone");
    return thread;
  }

  const info: ToolSpec<Record<string, never>> = {
    name: "thread.info",
    title: "Details",
    annotations: { readOnlyHint: true },
    description:
      "This thread's title, its set and replying model and effort, and its people. Check before changing any of them.",
    input: z.object({}).strict() as z.ZodType<Record<string, never>>,
    risk: () => "normal",
    async run(_input, ctx) {
      const thread = threadOf(ctx.threadId);
      const space = spaceStore.find(thread.spaceId);
      const model = space
        ? await models.replyModel(space, { model: thread.model, effort: thread.effort })
        : null;
      const writers = new Set<string>();
      for (const row of transcriptOf(threads.eventsAfter(thread.id, 0).map(eventSummary)).rows) {
        if (row.kind === "human" && !row.guest) writers.add(row.author.name);
      }
      return {
        ok: true,
        value: {
          title: thread.title,
          model: {
            chosen: { ref: thread.model ?? model?.chosen.ref ?? null, effort: thread.effort },
            replying: model?.used
              ? { ref: model.used.ref, name: model.used.name, effort: model.effort }
              : null,
          },
          people: [
            ...[...writers].map((name) => ({ name, guest: false })),
            ...guests
              .activeIn(thread.id, now())
              .map((guest) => ({ name: guest.name, guest: true })),
          ],
        },
      };
    },
  };

  const rename: ToolSpec<{ title: string }> = {
    name: "thread.rename",
    title: "Rename",
    annotations: { readOnlyHint: false },
    description: "Rename this thread.",
    input: z.object({
      title: z.string().trim().min(1).max(200).meta({ title: "Title" }),
    }),
    risk: () => "normal",
    run({ title }, ctx) {
      ctx.write((append) => {
        threads.update(ctx.threadId, { title, titleSource: "agent" });
        append({ type: "thread.renamed", actor: ctx.actor, data: { title } });
      });
      return Promise.resolve({ ok: true, value: { title } });
    },
  };

  const setModel: ToolSpec<{ model: string; effort: "low" | "medium" | "high" | null }> = {
    name: "thread.set_model",
    title: "Change model",
    annotations: { readOnlyHint: false },
    description:
      "Set this thread's model and effort together; null effort is the model's default. Applies from your next step.",
    input: z.object({
      model: z.string().min(1).meta({ title: "Model", description: "A model ref" }),
      effort: effortSchema.nullable().meta({ title: "Effort" }),
    }),
    risk: ({ model }, ctx) =>
      ctx.model && connectionOf(model) !== connectionOf(ctx.model) ? "ask" : "normal",
    async run({ model, effort }, ctx) {
      try {
        await models.requireModel(ctx.orgId, model);
      } catch (err) {
        if (err instanceof ServiceError) return { ok: false, error: err.message };
        throw err;
      }
      ctx.write(() => threads.update(ctx.threadId, { model, effort }));
      return { ok: true, value: { model, effort } };
    },
  };

  const compact: ToolSpec<{ focus?: string }> = {
    name: "thread.compact",
    title: "Compact",
    annotations: { readOnlyHint: false },
    description:
      "Summarise the earlier part of this thread: from your next step you read the summary in its place, then the recent part in full. People still see everything. Use when the thread is long; focus says what to keep.",
    input: z.object({
      focus: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .optional()
        .meta({ title: "Focus", description: "What the summary must keep" }),
    }),
    risk: () => "normal",
    async run({ focus }, ctx) {
      if (!ctx.model) return { ok: false, error: "No model replies in this thread." };
      const done = await compactThread({
        threadId: ctx.threadId,
        rows: transcriptOf(threads.eventsAfter(ctx.threadId, 0).map(eventSummary)).rows,
        model: await open(ctx.orgId, ctx.model),
        ...(ctx.threadRequest && { request: ctx.threadRequest() }),
        ...(focus && { focus }),
        actor: ctx.actor,
        write: (work) => ctx.write(work),
        signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS),
      });
      if (!done) return { ok: false, error: "There is nothing to compact yet." };
      const { summarised, tokensBefore, tokensAfter } = done;
      return { ok: true, value: { summarised, tokensBefore, tokensAfter } };
    },
  };

  return {
    id: "thread",
    title: "Thread",
    source: "builtin",
    tools: [info, rename, setModel, compact, askTool],
  };
}
