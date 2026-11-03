// What MCP prompts give people as commands: what a prompt takes, shown as a hint; the words after
// its command matched to its arguments in order, the last argument taking the rest; and what it
// gives back as the text the agent reads, its user messages' text and embedded text resources
// inlined, anything else only named, kept to a cap.

import type { McpPrompt, McpPromptResult } from "./client.ts";
import { RESOURCE_TEXT_MAX } from "./resources.ts";

// What a prompt takes, like <name> [tone]; null for one that takes nothing.
export function promptHint(prompt: McpPrompt): string | null {
  if (prompt.arguments.length === 0) return null;
  return prompt.arguments
    .map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`))
    .join(" ");
}

// The prompt's arguments from the words after its command: each takes one word in order, and the
// last takes everything left. Those it requires and was not given are missing.
export function promptArguments(
  prompt: McpPrompt,
  args: string,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const declared = prompt.arguments;
  const words = [...args.matchAll(/\S+/g)];
  declared.forEach((argument, index) => {
    const word = words[index];
    if (!word) return;
    values[argument.name] = index === declared.length - 1 ? args.slice(word.index).trim() : word[0];
  });
  const missing = declared
    .filter((argument) => argument.required && !values[argument.name])
    .map((argument) => argument.name);
  return { values, missing };
}

function textOf(value: unknown) {
  return typeof value === "string" ? value : "";
}

// One piece of a prompt's message as the agent reads it: text as text, an embedded resource's text
// as text, and anything else by its kind and type.
function partOf(content: Record<string, unknown>) {
  if (content.type === "text") return textOf(content.text);
  if (content.type === "resource") {
    const resource = (content.resource ?? {}) as Record<string, unknown>;
    if (typeof resource.text === "string") return resource.text;
    return `[resource ${[resource.uri, resource.mimeType].map(textOf).filter(Boolean).join(" ")}]`;
  }
  const named = [content.type, content.mimeType, content.name, content.uri].map(textOf);
  return `[${named.filter(Boolean).join(" ")}]`;
}

// What the prompt gave back, as the text the agent reads: its user messages, and any other's
// only by its role.
export function promptText(result: McpPromptResult) {
  const text = result.messages
    .map((message) =>
      message.role === "user" ? partOf(message.content) : `[a message from the ${message.role}]`,
    )
    .filter(Boolean)
    .join("\n\n");
  return text.length <= RESOURCE_TEXT_MAX
    ? text
    : `${text.slice(0, RESOURCE_TEXT_MAX)}\n\n(Cut short.)`;
}
