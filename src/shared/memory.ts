// Space memory: short entries the agent saves for the space's later threads, each of a type and
// under a topic. People see them in the space's settings, and a new thread's first notice.

import * as z from "zod";

// The toolset the agent keeps memory with, and its tools by id and by what the model calls them.
export const MEMORY_TOOLSET = "memory";
export const SAVE_MEMORY = "memory.save";
export const SEARCH_MEMORY = "memory.search";
export const SAVE_SKILL = "memory.save_skill";
export const SAVE_MEMORY_MODEL = "space.save_memory";
export const SEARCH_MEMORY_MODEL = "space.search_memory";
export const SAVE_SKILL_MODEL = "space.save_skill";

// The most files a learned skill keeps.
export const LEARNED_FILES_MAX = 20;

export const MEMORY_TYPES = [
  "fact",
  "decision",
  "preference",
  "procedure",
  "failure",
  "tool_quirk",
] as const;

export const memoryTypeSchema = z.enum(MEMORY_TYPES);

export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  fact: "Fact",
  decision: "Decision",
  preference: "Preference",
  procedure: "Procedure",
  failure: "Failure",
  tool_quirk: "Tool quirk",
};

// The most characters in an entry's text and in its topic.
export const MEMORY_TEXT_MAX = 500;
export const MEMORY_TOPIC_MAX = 60;

// An entry as the notice that opens a thread shows it.
export const memoryNoticeEntrySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  text: z.string(),
});

// The space's memory as a new thread's notice holds it: entries grouped by topic, and how many
// more there are than fit, with the topics only those have.
export const memoryNoticeSchema = z.object({
  topics: z.array(z.object({ topic: z.string(), entries: z.array(memoryNoticeEntrySchema) })),
  more: z.number().int().nonnegative(),
  moreTopics: z.array(z.string()).optional(),
});

export type MemoryNotice = z.infer<typeof memoryNoticeSchema>;

// An entry as the space's settings show it: where it came from, when the reader may open that
// thread, and who approved its save.
export const memoryEntrySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  topic: z.string(),
  text: z.string(),
  thread: z.object({ id: z.string(), title: z.string() }).nullable(),
  approvedBy: z.string().nullable(),
  savedAt: z.iso.datetime(),
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const spaceMemorySchema = z.object({
  entries: z.array(memoryEntrySchema),
  // Whether the reader may forget entries.
  canForget: z.boolean(),
});

export type SpaceMemory = z.infer<typeof spaceMemorySchema>;
