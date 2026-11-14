// Mage's built-in Thread toolset, whose tools act on the thread the agent replies in: reading its
// details, renaming it, changing the model and effort it replies with, compacting what it reads of
// it, and asking its people questions. Each is cheap and
// shows in the thread. Asking is always on; the rest are actions orgs and spaces set. Changing the
// model asks first when the new one comes through another connection than the one replying now,
// since the whole thread then goes to another provider. The agent names models by their aliases;
// threads store the refs they stand for.

import * as z from "zod";

import type { GuestStore } from "@/server/guests/service.ts";
import type { Models, OpenModel } from "@/server/models/service.ts";
import type { SpaceStore } from "@/server/spaces/service.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import type { Transcripts } from "@/server/threads/transcripts.ts";
import { effortSchema } from "@/shared/threads/thread.ts";

import { askTool } from "./ask.ts";
import { compact as compactThread, wholeWhereRead } from "@/server/execution/compaction.ts";
import type { Toolset, ToolSpec } from "./tools.ts";
import { personLabel } from "@/shared/people.ts";
import { parseModelRef } from "@/shared/model-ref.ts";

export interface SystemToolsOptions {
  threads: Pick<ThreadStore, "find" | "update">;
  transcripts: Pick<Transcripts, "of" | "whole">;
  spaceStore: Pick<SpaceStore, "find">;
  guests: Pick<GuestStore, "reachedIn">;
  models: Pick<Models, "replyModel" | "resolveModels" | "canonicalRef" | "aliasOf" | "modelLabels">;
  // Opens the model a thread replies with, to write the summary that compacts it.
  open: (orgId: string, ref: string) => Promise<OpenModel>;
  now?: () => Date;
}

// How long writing a summary may take.
const COMPACT_TIMEOUT_MS = 5 * 60 * 1000;

export function createSystemTools(options: SystemToolsOptions): Toolset {
  const { threads, spaceStore, guests, models, open } = options;
  const now = options.now ?? (() => new Date());

  async function threadOf(id: string) {
    const thread = await threads.find(id);
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
      const thread = await threadOf(ctx.threadId);
      const space = await spaceStore.find(thread.spaceId);
      const aliased = async (ref: string | null) => ref && (await models.aliasOf(ctx.orgId, ref));
      const model = space
        ? await models.replyModel(space, { model: thread.model, effort: thread.effort })
        : null;
      const writers = new Set<string>();
      for (const row of (await options.transcripts.of(thread.id)).transcript().rows) {
        if (row.kind === "human" && !row.guest) writers.add(personLabel(row.author));
      }
      return {
        ok: true,
        value: {
          title: thread.title,
          model: {
            chosen: {
              ref: await aliased(thread.model ?? model?.chosen.ref ?? null),
              effort: thread.effort,
            },
            replying: model?.used
              ? { ref: await aliased(model.used.ref), name: model.used.name, effort: model.effort }
              : null,
          },
          people: [
            ...[...writers].map((name) => ({ name, guest: false })),
            ...(await guests.reachedIn(thread.rootThreadId ?? thread.id, now())).map((guest) => ({
              name: guest.name,
              guest: true,
            })),
          ],
        },
      };
    },
  };

  const listModels: ToolSpec<Record<string, never>> = {
    name: "thread.list_models",
    title: "List models",
    annotations: { readOnlyHint: true },
    description:
      "List the enabled models available to this org, with exact refs for thread.set_model and subagents.start. Use these refs rather than guessing model names. Reports connections whose catalogs could not be read; a listed model is not a guarantee that inference will succeed.",
    input: z.object({}).strict() as z.ZodType<Record<string, never>>,
    risk: () => "normal",
    async run(_input, ctx) {
      const { models: available, errors } = await models.resolveModels(ctx.orgId);
      return {
        ok: true,
        value: {
          models: available.map(
            ({ alias, name, host, maker, connectionLabel, contextWindow, reasoning }) => ({
              ref: alias,
              name,
              host,
              maker,
              connection: connectionLabel,
              ...(contextWindow !== undefined && { contextWindow }),
              ...(reasoning !== undefined && { reasoning }),
            }),
          ),
          errors,
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
    async run({ title }, ctx) {
      await ctx.write(async (append) => {
        await threads.update(ctx.threadId, { title, titleSource: "agent" });
        await append({ type: "thread.renamed", actor: ctx.actor, data: { title } });
      });
      return Promise.resolve({ ok: true, value: { title } });
    },
  };

  const setModel: ToolSpec<{ model: string; effort: "low" | "medium" | "high" | null }> = {
    name: "thread.set_model",
    title: "Change model",
    annotations: { readOnlyHint: false },
    description:
      "Use a ref from thread.list_models. Set this thread's model and effort together; null effort is the model's default. Applies from your next step.",
    input: z.object({
      model: z.string().min(1).meta({ title: "Model", description: "A model ref" }),
      effort: effortSchema.nullable().meta({ title: "Effort" }),
    }),
    risk: async ({ model }, ctx) =>
      ctx.model &&
      parseModelRef(await models.canonicalRef(ctx.orgId, model)).connectionId !==
        parseModelRef(ctx.model).connectionId
        ? "ask"
        : "normal",
    // The model as people know it, its connection, and the effort.
    async summary({ model, effort }, space) {
      const label = await (await models.modelLabels(space.orgId))(model);
      return label && [label, effort].filter(Boolean).join(" · ");
    },
    async run({ model, effort }, ctx) {
      const ref = await models.canonicalRef(ctx.orgId, model);
      const { models: available, errors } = await models.resolveModels(ctx.orgId);
      const found = available.find((one) => one.ref === ref);
      if (!found) {
        const unreadable = errors.length > 0 ? " Some connections could not be read." : "";
        return { ok: false, error: `${model} is not a model this org can use.${unreadable}` };
      }
      await ctx.write(async () => threads.update(ctx.threadId, { model: ref, effort }));
      return {
        ok: true,
        value: { model: found.alias, name: found.name, connection: found.connectionLabel, effort },
      };
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
        rows: await wholeWhereRead(
          (await options.transcripts.of(ctx.threadId)).transcript().rows,
          options.transcripts.whole,
        ),
        model: await open(ctx.orgId, ctx.model),
        ...(ctx.threadRequest && { request: await ctx.threadRequest() }),
        ...(focus && { focus }),
        actor: ctx.actor,
        write: async (work) => ctx.write(work),
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
    tools: [info, listModels, rename, setModel, compact, askTool],
  };
}
