// The Thread toolset's `thread.ask`: the agent puts one to four questions, each with a few options,
// to the people in the thread and its run waits for an answer. It is always on and open, so anyone
// who can post in the thread may answer, in options or their own words, or skip the questions; the
// first answer wins, and the call gives back what was answered.

import type * as z from "zod";

import { ASK_TOOL, type AskInput, askInputSchema } from "@/shared/ask.ts";

import type { ToolSpec } from "./tools.ts";

export const askTool: ToolSpec<AskInput> = {
  name: ASK_TOOL,
  title: "Ask",
  waitsFor: "answer",
  fixed: true,
  annotations: { readOnlyHint: true },
  description:
    'Ask the people here one to four questions, two to four options each, when you need a choice before going on. Your turn pauses until someone answers. People can always write their own answer, so add no "Other" option. Put your recommended option first. Do not ask what you can find out or decide yourself.',
  input: askInputSchema as z.ZodType<AskInput>,
  risk: () => "normal",
  run(_input, ctx) {
    if (!ctx.answers) return Promise.resolve({ ok: false, error: "Nobody answered." });
    return Promise.resolve({ ok: true, value: { answers: ctx.answers } });
  },
};
