// The commands people give the agent in a thread by starting a message with a slash: the skills on
// in its space, which the agent then follows as if it had loaded them, and the prompts its MCP
// servers offer, named <server>:<prompt> and got with the credentials the server's calls go with.
// What a command stands for is worked out as it is sent and kept with the message, so the agent
// reads what it meant then.

import type { McpServers } from "@/server/mcp/service.ts";
import { promptHint } from "@/server/mcp/prompts.ts";
import type { Skill, Skills } from "@/server/skills/service.ts";
import type { Space } from "@/server/spaces/service.ts";
import type { CommandInput, ThreadCommand } from "@/shared/threads/commands.ts";

export interface CommandsOptions {
  skills: Pick<Skills, "effectiveIn">;
  prompts: Pick<McpServers, "promptsIn" | "runPrompt">;
}

export type Commands = ReturnType<typeof createCommands>;

// Where a skill's body takes the words given after its command.
const ARGUMENTS = "$ARGUMENTS";

// What the agent reads for a skill run as a command: what the person typed, then the skill's
// instructions with the words after its name in place of $ARGUMENTS, or after them when it has
// none.
export function skillText(
  skill: Pick<Skill, "name" | "body" | "files">,
  args: string,
  typed: string,
) {
  const body = skill.body.includes(ARGUMENTS)
    ? skill.body.replaceAll(ARGUMENTS, args)
    : args
      ? `${skill.body}\n\nARGUMENTS: ${args}`
      : skill.body;
  const files = skill.files.length
    ? [`Its files, to read as you need them: ${skill.files.map((file) => file.path).join(", ")}.`]
    : [];
  return [
    typed,
    `This runs the skill ${skill.name}. Follow its instructions as if you had loaded it.`,
    ...files,
    body,
  ].join("\n\n");
}

// What the agent reads for an MCP server's prompt run as a command.
export function promptMessage(server: string, name: string, text: string, typed: string) {
  return [typed, `This runs the prompt ${name} from the MCP server ${server}. It says:`, text].join(
    "\n\n",
  );
}

export function createCommands(options: CommandsOptions) {
  const { skills, prompts } = options;

  return {
    // The commands the person has in the space: its skills, then its servers' prompts.
    list(space: Pick<Space, "id" | "orgId">, userId: string): ThreadCommand[] {
      return [
        ...skills.effectiveIn(space).map((skill) => ({
          name: skill.name,
          description: skill.description,
          argumentHint: null,
          kind: "skill" as const,
          tag: "Skill",
        })),
        ...prompts.promptsIn(space, userId).map(({ server, serverName, prompt, connection }) => ({
          name: `${server}:${prompt.name}`,
          description: prompt.description ?? prompt.title ?? prompt.name,
          argumentHint: promptHint(prompt),
          kind: "prompt" as const,
          tag: serverName,
          ...(connection && { connection }),
        })),
      ];
    },

    // What the agent reads for the command the person sent with the text they typed; null for a
    // command the space does not have.
    async expand(
      space: Pick<Space, "id" | "orgId">,
      userId: string,
      command: CommandInput,
      typed: string,
    ): Promise<string | null> {
      const at = command.name.indexOf(":");
      if (at === -1) {
        const skill = skills.effectiveIn(space).find((found) => found.name === command.name);
        return skill ? skillText(skill, command.args, typed) : null;
      }
      const slug = command.name.slice(0, at);
      const name = command.name.slice(at + 1);
      const got = await prompts.runPrompt(space, userId, slug, name, command.args);
      return got && promptMessage(got.server, name, got.text, typed);
    },
  };
}
