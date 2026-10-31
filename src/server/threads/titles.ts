// Names a thread after its first message with a model, alongside the agent's reply: the org's
// title model, or one chosen automatically, or the thread's own model. A title a person gave the
// thread is never replaced, and a title that cannot be had leaves the one from the message.

import type { Logger } from "@/server/kernel/logger.ts";
import type { ModelUsage } from "@/server/models/gateway.ts";
import type { Models } from "@/server/models/service.ts";

import { type ThreadStore, titleFrom } from "./service.ts";
import type { ThreadLog } from "./log.ts";

export interface TitlesOptions {
  models: Pick<Models, "chosenTitleModel" | "automaticTitleModel" | "defaultModel" | "open">;
  threads: Pick<ThreadStore, "find" | "update">;
  log: ThreadLog;
  logger: Logger;
  // How long a title may take.
  timeoutMs?: number;
}

export type Titles = ReturnType<typeof createTitles>;

const INSTRUCTIONS = [
  "You name conversations.",
  "Reply with a title of at most six words for the conversation that starts with the message you are given.",
  "Reply with the title alone: no quotes, no trailing punctuation, no Markdown.",
].join("\n");

// The model's answer as a title: its first line, without a label or quotes.
export function cleanTitle(answer: string) {
  const line = answer
    .split("\n")
    .map((text) => text.trim())
    .find(Boolean);
  if (!line) return "";
  const bare = line
    .replace(/^title:\s*/i, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[.。]+$/, "");
  return titleFrom(bare);
}

export function createTitles(options: TitlesOptions) {
  const { models, threads, log, logger } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function modelFor(orgId: string, threadModel: string | null) {
    const chosen = models.chosenTitleModel(orgId);
    if (chosen) return chosen;
    const automatic = await models.automaticTitleModel(orgId).catch(() => null);
    return automatic ?? threadModel ?? models.defaultModel(orgId);
  }

  async function titleOf(orgId: string, threadId: string, ref: string, text: string) {
    const model = await models.open(orgId, ref);
    let answer = "";
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    const stream = model.stream(
      {
        instructions: INSTRUCTIONS,
        messages: [{ role: "user", text }],
        maxSteps: 1,
        sessionId: `${threadId}:title`,
        effort: "low",
      },
      AbortSignal.timeout(timeoutMs),
    );
    for await (const event of stream) {
      if (event.type === "delta") answer += event.text;
      if (event.type === "step-end") {
        usage.inputTokens += event.usage.inputTokens;
        usage.outputTokens += event.usage.outputTokens;
      }
    }
    return { title: cleanTitle(answer), usage };
  }

  return {
    // Resolves once the thread is named, or it is given up on.
    async name(orgId: string, threadId: string, text: string) {
      try {
        const thread = threads.find(threadId);
        if (!thread || thread.titleSource === "person") return;
        const ref = await modelFor(orgId, thread.model);
        if (!ref) return;
        const { title, usage } = await titleOf(orgId, threadId, ref, text);
        if (!title) return;
        log.write(threadId, (append) => {
          const current = threads.find(threadId);
          if (!current || current.titleSource === "person") return;
          threads.update(threadId, { title, titleSource: "agent" });
          const used = usage.inputTokens + usage.outputTokens > 0;
          append({
            type: "thread.renamed",
            actor: { kind: "agent" },
            data: { title, ...(used && { usage }) },
          });
        });
      } catch (err) {
        logger.info({ err, threadId }, "thread not named");
      }
    },
  };
}
