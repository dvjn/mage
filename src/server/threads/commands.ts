// The commands people give the agent in a thread by starting a message with a slash: the skills on
// in its space, which the agent then follows as if it had loaded them, and the prompts its MCP
// servers offer, named <server>:<prompt> and got with the credentials the server's calls go with.
// What a command stands for is worked out as it is sent and kept with the message, so the agent
// reads what it meant then. Beside them, Mage's own: compacting the thread and asking aside.

import type { ThreadAccess } from "@/server/access/access.ts";
import type { McpServers } from "@/server/mcp/service.ts";
import { promptHint } from "@/server/mcp/prompts.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Skill, Skills } from "@/server/skills/service.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import { BTW, COMPACT, type CommandInput, type ThreadCommand } from "@/shared/threads/commands.ts";

export interface CommandsOptions {
  skills: Pick<Skills, "effectiveIn">;
  prompts: Pick<McpServers, "promptsIn" | "runPrompt">;
  access: Pick<ThreadAccess, "require">;
  spaces: Pick<Spaces, "require" | "can">;
  spaceStore: Pick<SpaceStore, "find">;
  // Whether side questions are answered here, which offers the command that asks one.
  asides: boolean;
}

// Mage's own commands, which anyone who can post may send.
const COMPACT_COMMAND: ThreadCommand = {
  name: COMPACT,
  description: "Summarise earlier messages for the agent",
  argumentHint: "[focus]",
  kind: "builtin",
  tag: null,
};

const BTW_COMMAND: ThreadCommand = {
  name: BTW,
  description: "Ask aside about the last message",
  argumentHint: "<question>",
  kind: "builtin",
  tag: null,
};

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
  const { skills, prompts, access, spaces, spaceStore } = options;

  // The commands the person has in the space: its skills, then its servers' prompts.
  async function list(
    space: Pick<Space, "id" | "orgId">,
    userId: string,
  ): Promise<ThreadCommand[]> {
    return [
      ...(await skills.effectiveIn(space)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        argumentHint: null,
        kind: "skill" as const,
        tag: "Skill",
      })),
      ...(await prompts.promptsIn(space, userId)).map(
        ({ server, serverName, prompt, connection }) => ({
          name: `${server}:${prompt.name}`,
          description: prompt.description ?? prompt.title ?? prompt.name,
          argumentHint: promptHint(prompt),
          kind: "prompt" as const,
          tag: serverName,
          ...(connection && { connection }),
        }),
      ),
    ];
  }

  // The commands of the space's skills and servers, apart from Mage's own.
  async function others(space: Pick<Space, "id" | "orgId">, userId: string) {
    return (await list(space, userId)).filter(
      (command) => command.name !== COMPACT && command.name !== BTW,
    );
  }

  return {
    list,

    // The commands the reader may send in the thread; none for those who may not post.
    async inThread(principal: Principal, id: string): Promise<ThreadCommand[]> {
      const read = await access.require(principal, id);
      const space = await spaceStore.find(read.thread.spaceId);
      if (!space || !read.can("post")) return [];
      return [
        COMPACT_COMMAND,
        ...(options.asides ? [BTW_COMMAND] : []),
        ...(await others(space, principal.userId)),
      ];
    },

    // The commands the reader may send to start a thread in the space, which has nothing yet to
    // compact or ask aside about; none for those who may not start threads there.
    async inSpace(principal: Principal, spaceId: string): Promise<ThreadCommand[]> {
      const view = await spaces.require(principal, spaceId, "read");
      const space = await spaceStore.find(spaceId);
      if (!space || !(await spaces.can(principal, view, "message"))) return [];
      return others(space, principal.userId);
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
        const skill = (await skills.effectiveIn(space)).find(
          (found) => found.name === command.name,
        );
        return skill ? skillText(skill, command.args, typed) : null;
      }
      const slug = command.name.slice(0, at);
      const name = command.name.slice(at + 1);
      const got = await prompts.runPrompt(space, userId, slug, name, command.args);
      return got && promptMessage(got.server, name, got.text, typed);
    },
  };
}
