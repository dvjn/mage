// Questions the agent puts to the people in a thread, shared by the server and the web client: what
// a `thread.ask` call takes (one to four questions, each with a short header, two to four options
// and whether several may be picked), and the answers someone gives, keyed by question: one label
// or text, or several for a question that takes many. Any answer may be the person's own words.

import * as z from "zod";

export const ASK_TOOL = "thread.ask";

export const askOptionSchema = z.object({
  label: z.string().trim().min(1).max(60).meta({ description: "What the option says, briefly" }),
  description: z.string().trim().max(300).optional().meta({ description: "What picking it means" }),
  preview: z
    .string()
    .max(4000)
    .optional()
    .meta({ description: "Markdown shown beside the option, such as a sample or a sketch" }),
});

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1).max(500).meta({ description: "The whole question" }),
  header: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .meta({ description: "A word or two the question is tagged with" }),
  options: z.array(askOptionSchema).min(2).max(4),
  multiSelect: z
    .boolean()
    .default(false)
    .meta({ description: "Whether several options may be picked" }),
});

export const askInputSchema = z.object({
  questions: z
    .array(askQuestionSchema)
    .min(1)
    .max(4)
    .refine((questions) => new Set(questions.map((q) => q.question)).size === questions.length, {
      message: "Each question must be different",
    }),
});

export type AskInput = z.infer<typeof askInputSchema>;
export type AskQuestion = z.infer<typeof askQuestionSchema>;

const answerText = z.string().trim().min(1).max(2000);

// What someone answered, by question.
export const askAnswersSchema = z.record(z.string(), z.union([answerText, z.array(answerText)]));

export type AskAnswers = z.infer<typeof askAnswersSchema>;

// An answer to a call's questions, or null to skip them.
export const toolAnswerSchema = z.object({ answers: askAnswersSchema.nullable() });

// What is wrong with the answers to these questions: one for each and no others, several only
// where several may be picked; null when nothing is.
export function answersProblem(questions: readonly AskQuestion[], answers: AskAnswers) {
  const asked = new Set(questions.map((question) => question.question));
  if (Object.keys(answers).some((key) => !asked.has(key))) return "Answer only the questions asked";
  for (const question of questions) {
    const answer = answers[question.question];
    if (answer === undefined || (Array.isArray(answer) && answer.length === 0)) {
      return `Answer: ${question.question}`;
    }
    if (Array.isArray(answer) && !question.multiSelect) {
      return `Pick one answer to: ${question.question}`;
    }
  }
  return null;
}
