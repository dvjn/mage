// What the stand-in model does at a step, worked out from the conversation alone, so that the
// in-process stand-in and the mock's provider APIs answer alike. It says how many messages from
// people and agents it has read, then a few more words; many more when the newest message asks it to
// reply slowly, more still very slowly, and it reasons for a few words first when it asks it to
// think. The newest message steers it with lines that start with `^`:
// - `^tool <id> <json>` calls that tool after its words, when it is offered, or says it cannot.
//   Where tools it is not offered can be searched for and no line searches itself, it first selects
//   them with the tool search instead. Shown what the calls gave back, it says so, and calls those of
//   the lines it has not called yet that are offered by then, as after a tool that turned others on.
// - `^fail <text>` fails with that text after its words.
// - `^status <code> [retry-after=<seconds>] [<text>]` refuses the request as a provider does with
//   that status, before any words.
// - `^stall <ms>` waits that long before it starts.
// - `^drop` cuts the reply off after its words, as a lost connection does.
// - `^prompt` says its system prompt and what it was given ahead of the conversation, a line at a
//   time, in place of its words.
// - `^say` replies with the rest of the message, a few characters at a time.
// It imports no values from the server, so the mock runs it as it is.

import type { ModelMessage } from "@/server/models/gateway.ts";

// How long the stand-in waits before each piece it streams.
export const PIECE_MS = 40;

const FILLER = "and so the engine turns its wheels".split(" ");
const REASONING = "Considering the gears and the levers".split(" ");
// A steering line of a person's message, after the name it starts with.
const LEAD = String.raw`^(?:\[[^\]\n]*\][ \t]*)?\^`;
const TOOL_LINE = new RegExp(String.raw`${LEAD}tool[ \t]+(\S+)[ \t]*(.*)$`, "gm");
const FAIL_LINE = new RegExp(String.raw`${LEAD}fail[ \t]+(.+)$`, "m");
const STATUS_LINE = new RegExp(
  String.raw`${LEAD}status[ \t]+(\d{3})(?:[ \t]+retry-after=(\d+))?(?:[ \t]+(.+))?$`,
  "m",
);
const STALL_LINE = new RegExp(String.raw`${LEAD}stall[ \t]+(\d+)[ \t]*$`, "m");
const DROP_LINE = new RegExp(String.raw`${LEAD}drop[ \t]*$`, "m");
const PROMPT_LINE = new RegExp(String.raw`${LEAD}prompt[ \t]*$`, "m");
// Everything after a `^say` line is the reply.
const SAY_LINE = new RegExp(String.raw`${LEAD}say[ \t]*\n([\s\S]*)$`, "m");
const SAY_CHARS = 6;

export interface ScriptRequest {
  instructions: string;
  // The conversation, without what changed in it.
  messages: Exclude<ModelMessage, { role: "change" }>[];
  // The names of the tools it is offered, and of the one that turns others on.
  offered: ReadonlySet<string>;
  search: string;
  // A tool's name as the request gives it; providers take ids under other names.
  nameOf?: (toolId: string) => string;
  // Whether a message is one given ahead of the conversation rather than someone's words.
  isLead?: (message: ModelMessage) => boolean;
}

export interface ScriptStep {
  stall: number;
  // A refusal in place of the step, as a provider's status, the seconds to wait, and its words.
  status: { code: number; retryAfter: number | null; message: string } | null;
  reasoning: string[];
  text: string[];
  // Each by its id and by its name in the request.
  calls: { toolId: string; toolName: string; input: unknown }[];
  // A failure after the words, and whether the words are cut off there.
  fail: string | null;
  drop: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

// The tool calls a message asks for, by name with their input as sent.
function toolLines(text: string, nameOf: (toolId: string) => string) {
  return [...text.matchAll(TOOL_LINE)].map(([, toolId, json]) => {
    let input: unknown = json;
    try {
      input = JSON.parse(json || "{}");
    } catch {
      // Sent as written, for the tool to refuse.
    }
    return { toolId: toolId!, toolName: nameOf(toolId!), input };
  });
}

// Words as they stream, each after the first led by its space.
function spaced(words: string[]) {
  return words.map((word, index) => (index === 0 ? word : ` ${word}`));
}

function said(message: Extract<ModelMessage, { role: "tool" }>) {
  return message.results.map((result) => {
    const what = result.output.ok
      ? `ok ${JSON.stringify(result.output.value)}`
      : `error ${result.output.error}`;
    return `Tool ${result.toolId} said: ${what}`;
  });
}

export function scriptStep(request: ScriptRequest): ScriptStep {
  const nameOf = request.nameOf ?? ((toolId: string) => toolId);
  const isLead = request.isLead ?? (() => false);
  const { messages, offered } = request;
  const search = nameOf(request.search);
  const last = messages.at(-1);
  const words = last?.role === "user" ? last.text : "";
  const step: ScriptStep = {
    stall: Number(STALL_LINE.exec(words)?.[1] ?? 0),
    status: null,
    reasoning: /think/i.test(words) ? spaced(REASONING) : [],
    text: [],
    calls: [],
    fail: FAIL_LINE.exec(words)?.[1] ?? null,
    drop: DROP_LINE.test(words),
    usage: { inputTokens: 10, outputTokens: 0 },
  };
  const status = STATUS_LINE.exec(words);
  if (status) {
    step.status = {
      code: Number(status[1]),
      retryAfter: status[2] ? Number(status[2]) : null,
      message: status[3] ?? `Refused with ${status[1]}`,
    };
    return step;
  }
  const scripted = SAY_LINE.exec(words);
  if (scripted) {
    const text = scripted[1]!;
    for (let at = 0; at < text.length; at += SAY_CHARS)
      step.text.push(text.slice(at, at + SAY_CHARS));
    step.usage.outputTokens = text.length;
    return step;
  }
  // Once shown what its calls gave back, it calls those of the newest message's lines it has not
  // called yet and is now offered.
  const asked = messages.findLast(
    (message): message is Extract<ModelMessage, { role: "user" }> => message.role === "user",
  );
  const since = messages.slice(asked ? messages.lastIndexOf(asked) : 0);
  const called = since.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).map((call) => nameOf(call.toolId))
      : [],
  );
  const wanted =
    last?.role === "tool"
      ? toolLines(asked?.text ?? "", nameOf).filter(({ toolName }) => {
          const index = called.indexOf(toolName);
          if (index === -1) return true;
          called.splice(index, 1);
          return false;
        })
      : toolLines(words, nameOf);
  // Tools it is not offered, which it turns on itself unless the message searches for them.
  const unoffered = wanted
    .filter(({ toolName }) => !offered.has(toolName))
    .map(({ toolId }) => toolId);
  const selects =
    last?.role === "user" &&
    offered.has(search) &&
    unoffered.length > 0 &&
    !wanted.some(({ toolName }) => toolName === search);
  if (last?.role === "tool") {
    step.text = spaced(said(last).join(" ").split(" "));
  } else if (PROMPT_LINE.test(words)) {
    step.text = [
      request.instructions,
      ...messages.filter(isLead).map((message) => `\n\n${(message as { text: string }).text}`),
    ]
      .join("")
      .split(/(?<=\n)/);
  } else {
    const read = messages.filter((message) => message.role === "user" && !isLead(message));
    const latest = (read.at(-1) as { text: string } | undefined)?.text ?? "";
    const count = /very slowly/i.test(latest) ? 300 : /slowly/i.test(latest) ? 60 : 8;
    step.text = spaced([
      ..."I have read".split(" "),
      String(read.length),
      read.length === 1 ? "message," : "messages,",
      ...Array.from({ length: count }, (_, index) => FILLER[index % FILLER.length]!),
      ...(selects ? [] : unoffered).flatMap((toolId) => `I cannot use ${toolId} here.`.split(" ")),
    ]);
  }
  step.calls = [
    ...(selects
      ? [{ toolId: request.search, toolName: search, input: { select: [...new Set(unoffered)] } }]
      : []),
    ...wanted.filter(({ toolName }) => offered.has(toolName)),
  ];
  step.usage.outputTokens = step.text.length;
  return step;
}
