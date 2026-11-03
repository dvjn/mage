// Mage's built-in Thread toolset, whose tools act on the thread the agent replies in: reading its
// details, renaming it, moving it to one of its space's folders, changing the model and effort it
// replies with, compacting what it reads of it, and asking its people questions. Each is cheap and
// shows in the thread. Asking is always on; the rest are actions orgs and spaces set. Changing the
// model asks first when the new one comes through another connection than the one replying now,
// since the whole thread then goes to another provider.

import * as z from "zod";

import type { FolderStore } from "@/server/folders/service.ts";
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
  folders: Pick<FolderStore, "find" | "listInSpace">;
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
  const { threads, spaceStore, folders, guests, models, open } = options;
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
      "Read this thread's title, folder, the model and effort it is set to and the one replying, and the people in it. Check it before changing any of them.",
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
          folder: thread.folderId ? (folders.find(thread.folderId)?.name ?? null) : null,
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

  const move: ToolSpec<{ folder: string | null }> = {
    name: "thread.move",
    title: "Move",
    annotations: { readOnlyHint: false },
    description:
      "Move this thread to one of its space's folders, by name, or to the top of the space with null. It does not make folders.",
    input: z.object({
      folder: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .meta({ title: "Folder", description: "Its name; null for the top of the space" }),
    }),
    risk: () => "normal",
    run({ folder }, ctx) {
      const found =
        folder === null
          ? null
          : folders
              .listInSpace(ctx.spaceId)
              .find((candidate) => candidate.name.toLowerCase() === folder.toLowerCase());
      if (found === undefined) {
        const names = folders.listInSpace(ctx.spaceId).map((candidate) => candidate.name);
        return Promise.resolve({
          ok: false,
          error: names.length
            ? `No folder is named ${folder}. The folders here: ${names.join(", ")}.`
            : `No folder is named ${folder}. This space has no folders.`,
        });
      }
      ctx.write(() => threads.update(ctx.threadId, { folderId: found?.id ?? null }));
      return Promise.resolve({ ok: true, value: { folder: found?.name ?? null } });
    },
  };

  const setModel: ToolSpec<{ model: string; effort: "low" | "medium" | "high" | null }> = {
    name: "thread.set_model",
    title: "Change model",
    annotations: { readOnlyHint: false },
    description:
      "Set the model this thread replies with and its reasoning effort, together; null effort uses the model's usual one. Takes effect from your next step.",
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
      "Summarise the earlier part of this thread, so that from your next step you read the summary in its place and the most recent part in full. People still see the whole thread. Use it when the thread has grown long; give a focus to say what the summary must keep.",
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
    tools: [info, rename, move, setModel, compact, askTool],
  };
}
