// Searching for MCP tools. A run never sends the MCP tools it offers up front: the prompt names
// each by server with a line of what it does, and Mage's own search_tools turns them on by a ranked
// keyword query, by exact name, or after listing a server's tools. A tool turned on joins the
// requests from the model's next step for the rest of the run, and is called directly, so its
// policies, approvals and login are its own. Mage's own tools are always sent. The search is always
// on where there are MCP tools, and no policy applies to it: it only shows tools the space offers.

import * as z from "zod";

import { MCP_OWN_TOOLSET } from "@/shared/mcp.ts";
import { type JsonSchema, wireToolName } from "@/shared/tools.ts";

import type {
  AnyToolSpec,
  DeferredTool,
  ToolContext,
  ToolOutput,
  Toolset,
  ToolSpec,
} from "./tools.ts";

export const TOOL_SEARCH = `${MCP_OWN_TOOLSET}.search_tools`;

// The most matches a query turns on.
export const SEARCH_MATCHES_MAX = 8;

// The longest line of what a tool does, in the prompt and in results.
const LINE_MAX = 120;

// The first line of what a tool does, cut to fit.
export function lineOf(description: string) {
  const line = description.trim().split("\n")[0]!.trim();
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1).trimEnd()}…` : line;
}

// What a tool takes, in short: each parameter with its type, `?` where it may be left out.
export function parametersOf(schema: JsonSchema) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties)
    .map(([name, property]) => `${name}${required.has(name) ? "" : "?"}: ${typeOf(property)}`)
    .join(", ");
}

function typeOf(property: JsonSchema): string {
  if (Array.isArray(property.enum)) {
    return property.enum
      .slice(0, 5)
      .map((value) => JSON.stringify(value))
      .join(" | ");
  }
  const type = property.type;
  if (type === "array") {
    const items = property.items as JsonSchema | undefined;
    return `${items ? typeOf(items) : "any"}[]`;
  }
  if (Array.isArray(type)) return type.join(" | ");
  return typeof type === "string" ? type : "any";
}

function wordsOf(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// The tool's own name, after its server's prefix.
function ownName(tool: Pick<DeferredTool, "name" | "prefix">) {
  return tool.prefix && tool.name.startsWith(`${tool.prefix}.`)
    ? tool.name.slice(tool.prefix.length + 1)
    : tool.name;
}

// How well the tool matches the query's words: most for a word of its own name, less for its
// server's, least for its description; a query that is its exact name matches best of all.
function scoreOf(tool: DeferredTool, query: string, terms: readonly string[]) {
  const lower = query.trim().toLowerCase();
  if (lower === tool.name.toLowerCase() || lower === ownName(tool).toLowerCase()) return 1_000;
  const own = wordsOf(ownName(tool));
  const server = wordsOf(`${tool.server} ${tool.prefix}`);
  const described = wordsOf(tool.description);
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    let found = 0;
    if (own.includes(term)) found += 10;
    else if (
      own.some((word) => word.startsWith(term) || (word.length > 3 && term.startsWith(word)))
    ) {
      found += 6;
    }
    if (server.includes(term)) found += 3;
    if (described.includes(term)) found += 2;
    else if (described.some((word) => term.length > 3 && word.startsWith(term))) found += 1;
    score += found;
    if (found > 0) matched += 1;
  }
  // A tool matching every word comes before one matching some of them strongly.
  return matched === terms.length ? score + 20 : score;
}

// The tools matching the query best, best first, ties by name.
export function rank(tools: readonly DeferredTool[], query: string, limit = SEARCH_MATCHES_MAX) {
  const terms = [...new Set(wordsOf(query))];
  if (terms.length === 0) return [];
  return tools
    .map((tool) => ({ tool, score: scoreOf(tool, query, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => tool);
}

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

// The tool a name means: its name exactly, in any case, as providers spell it, or its own name
// without the server's prefix when only one server has a tool by it.
export function resolve(tools: readonly DeferredTool[], name: string) {
  const lower = name.trim().toLowerCase();
  const exact = tools.find((tool) => tool.name === name.trim());
  if (exact) return exact;
  const loose = tools.filter(
    (tool) => tool.name.toLowerCase() === lower || wireToolName(tool.name).toLowerCase() === lower,
  );
  if (loose.length === 1) return loose[0]!;
  const own = tools.filter((tool) => ownName(tool).toLowerCase() === lower);
  return own.length === 1 ? own[0]! : null;
}

// The names closest to one that matched none, closest first.
export function closest(tools: readonly DeferredTool[], name: string, limit = 3) {
  const lower = name.trim().toLowerCase();
  return tools
    .map((tool) => ({
      tool,
      by: Math.min(
        distance(lower, tool.name.toLowerCase()),
        distance(lower, ownName(tool).toLowerCase()),
      ),
    }))
    .filter(({ tool, by }) => by <= Math.max(3, Math.floor(ownName(tool).length / 3)))
    .sort((a, b) => a.by - b.by || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => tool.name);
}

// A tool as a search gives it back: enough to call it once it is on.
function found(tool: DeferredTool) {
  return {
    name: tool.name,
    server: tool.server,
    description: lineOf(tool.description),
    parameters: parametersOf(tool.inputSchema),
  };
}

// The servers' tools as the prompt lists them, by server.
export function deferredByServer(tools: readonly DeferredTool[]) {
  const servers = new Map<
    string,
    { server: string; prefix: string; tools: { name: string; description: string }[] }
  >();
  for (const tool of tools) {
    const group = servers.get(tool.prefix) ?? {
      server: tool.server,
      prefix: tool.prefix,
      tools: [],
    };
    group.tools.push({ name: tool.name, description: lineOf(tool.description) });
    servers.set(tool.prefix, group);
  }
  return [...servers.values()];
}

type SearchInput = { query?: string; select?: string[]; server?: string };

const searchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({ title: "Query", description: "Words for what the tool does or is called" }),
    select: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(20)
      .optional()
      .meta({ title: "Tools", description: "Exact tool names to turn on" }),
    server: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({ title: "Server", description: "A server whose tools to list, by name or prefix" }),
  })
  .refine((input) => !!(input.query ?? input.select ?? input.server), {
    message: "Give a query, tools to select, or a server",
  }) as z.ZodType<SearchInput>;

// The server a name means: by its name or its tools' prefix, in any case, with or without mcp.
function serverOf(tools: readonly DeferredTool[], name: string) {
  const lower = name.trim().toLowerCase().replace(/\.\*$/, "");
  return tools.find(
    (tool) =>
      tool.server.toLowerCase() === lower ||
      tool.prefix.toLowerCase() === lower ||
      tool.prefix.toLowerCase() === `mcp.${lower}`,
  );
}

function search(input: SearchInput, deferred: NonNullable<ToolContext["deferred"]>): ToolOutput {
  const { tools, on } = deferred;
  const turnOn: DeferredTool[] = [];
  const value: Record<string, unknown> = {};
  if (input.select) {
    const unknown: { name: string; didYouMean: string[] }[] = [];
    for (const name of input.select) {
      const tool = resolve(tools, name);
      if (tool) turnOn.push(tool);
      else unknown.push({ name, didYouMean: closest(tools, name) });
    }
    value.selected = turnOn.map(found);
    if (unknown.length) value.unknown = unknown;
  }
  if (input.query) {
    const matches = rank(tools, input.query);
    turnOn.push(...matches);
    value.matches = matches.map(found);
  }
  if (input.server) {
    const server = serverOf(tools, input.server);
    if (!server) {
      const names = [...new Set(tools.map((tool) => `${tool.server} (${tool.prefix})`))];
      return {
        ok: false,
        error: `No server here is called ${input.server}. The servers: ${names.join(", ")}.`,
      };
    }
    value.server = {
      name: server.server,
      tools: tools.filter((tool) => tool.prefix === server.prefix).map(found),
    };
  }
  const ids = [...new Set(turnOn.map((tool) => tool.id))];
  if (ids.length) deferred.turnOn(ids);
  const now = turnOn.filter((tool) => !on.has(tool.id)).map((tool) => tool.name);
  return {
    ok: true,
    value: {
      ...value,
      turnedOn: [...new Set(now)],
      ...(ids.length > 0 && { note: "Tools turned on can be called from your next step." }),
    },
  };
}

// Searching for the MCP tools a run leaves out, and turning them on; of use where the space has MCP
// servers.
export function createToolSearch(
  hasServers: (space: { id: string; orgId: string }) => boolean,
): ToolSpec<SearchInput> {
  return {
    name: TOOL_SEARCH,
    title: "Search tools",
    annotations: { readOnlyHint: true },
    description:
      "Find and turn on MCP tools left out of your tools: with query, the best matches by name, server and description; with select, the tools named exactly; with server, a list of that server's tools. Matches and selected tools can be called from your next step.",
    input: searchInput,
    risk: () => "normal",
    usefulIn: hasServers,
    run(input, ctx) {
      if (!ctx.deferred) {
        return Promise.resolve({ ok: false, error: "No MCP tools are here to search for." });
      }
      return Promise.resolve(search(input, ctx.deferred));
    },
  };
}

// Mage's own MCP toolset: the tools that work across the space's servers, each always on where it
// is of use, and listed in settings where the org or the space has servers.
export function createMcpTools(tools: AnyToolSpec[], hasServers: Toolset["listedIn"]): Toolset {
  return {
    id: MCP_OWN_TOOLSET,
    title: "MCP",
    source: "builtin",
    tools,
    fixed: true,
    listedIn: hasServers,
  };
}
