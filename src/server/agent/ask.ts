// The Thread toolset's `thread.ask`: the agent puts one to four questions, each with a few options,
// to the people in the thread and its run waits for an answer. Anyone the tool's rules let use or
// approve it may answer, in options or their own words, or skip the questions; the first answer
// wins, and the call gives back what was answered.

import type * as z from "zod";

import { ASK_TOOL, type AskInput, askInputSchema } from "@/shared/ask.ts";

import type { ToolSpec } from "./tools.ts";

export const askTool: ToolSpec<AskInput> = {
  name: ASK_TOOL,
  title: "Ask",
  waitsFor: "answer",
  annotations: { readOnlyHint: true },
  description:
    'Ask the people in this thread one to four questions, each with two to four options, when you need a choice made before you go on. Your turn pauses until someone answers; anyone may write their own answer instead of an option, so do not add an "Other" option. Put the option you recommend first. Do not ask what you can find out or decide yourself.',
  input: askInputSchema as z.ZodType<AskInput>,
  risk: () => "normal",
  run(_input, ctx) {
    if (!ctx.answers) return Promise.resolve({ ok: false, error: "Nobody answered." });
    return Promise.resolve({ ok: true, value: { answers: ctx.answers } });
  },
};
