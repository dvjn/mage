// The commands a reader can give the agent in a thread by starting a message with a slash: Mage's
// own, which compacts the thread, the skills on in its space and the prompts of its MCP servers,
// each with what it takes; and how a message's text names one.

import * as z from "zod";

import { toolConnectionSchema } from "@/shared/tools.ts";

// Where a command comes from: Mage itself, a skill, or a prompt an MCP server offers.
export const commandKindSchema = z.enum(["builtin", "skill", "prompt"]);

// Mage's own command that compacts the thread, with what the summary should keep after it.
export const COMPACT = "compact";

export const threadCommandSchema = z.object({
  // What follows the slash: a skill's name, or <server>:<prompt> for an MCP server's prompt.
  name: z.string(),
  description: z.string(),
  // What it takes after its name, like <name> [tone]; null when it says nothing.
  argumentHint: z.string().nullable(),
  kind: commandKindSchema,
  // A word on what it is, shown beside it: Skill, or the name of the server whose prompt it is;
  // null for Mage's own.
  tag: z.string().nullable(),
  // For a prompt of a server whose credentials are personal, the reader's own connection to it.
  connection: toolConnectionSchema.optional(),
});

export type ThreadCommand = z.infer<typeof threadCommandSchema>;

export const threadCommandsSchema = z.array(threadCommandSchema);

// A command a message is sent as: its name and the rest of the text after it.
export const commandInputSchema = z.object({
  name: z.string().min(1).max(200),
  args: z.string().max(100_000),
});

export type CommandInput = z.infer<typeof commandInputSchema>;

// The command the text starts with: the first word after a leading slash, and what follows it.
export function commandOf(text: string): CommandInput | null {
  const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!, args: (match[2] ?? "").trim() };
}
