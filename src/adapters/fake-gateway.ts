// A stand-in model for the browser journeys, chosen by configuration and refused in production.
// It says how many messages from people it has read, then a few more words, one every few tens of
// milliseconds; it keeps going much longer when the newest message asks it to reply slowly, longer
// still very slowly, and
// reasons for a few words first when it asks it to think. Each `/tool <id> <json>` line in the
// newest message makes it call that tool after its words, when it is offered, or say it cannot;
// shown what the calls gave back, it says so. A `/fail <text>` line makes it fail with that text
// after its words. A `/prompt` line makes it say its system prompt in place of its words, and a
// `/say` line makes it reply with the rest of the message, a few characters at a time. Its lists
// stand in for hosts' lists: they take any key starting with `sk-`.

import { setTimeout as delay } from "node:timers/promises";

import { ulid } from "ulid";

import type { Catalog } from "@/ports/catalog.ts";
import type { ModelMessage, ModelToolCall, ModelToolResult } from "@/ports/model-gateway.ts";
import type { ModelGateway } from "@/ports/model-gateway.ts";
import { HOST_IDS, type HostId, hostOf } from "@/shared/hosts.ts";

export const FAKE_MODEL_REF = "fake/echo";

const WORD_MS = 40;
const FILLER = "and so the engine turns its wheels".split(" ");
const REASONING = "Considering the gears and the levers".split(" ");
// A line of a person's message, after the name it starts with.
const TOOL_LINE = /^(?:\[[^\]\n]*\][ \t]*)?\/tool[ \t]+(\S+)[ \t]*(.*)$/gm;
const FAIL_LINE = /^(?:\[[^\]\n]*\][ \t]*)?\/fail[ \t]+(.+)$/m;
const PROMPT_LINE = /^(?:\[[^\]\n]*\][ \t]*)?\/prompt[ \t]*$/m;
// Everything after a `/say` line is the reply.
const SAY_LINE = /^(?:\[[^\]\n]*\][ \t]*)?\/say[ \t]*\n([\s\S]*)$/m;
const SAY_CHARS = 6;

function wordsFor(messages: ModelMessage[]) {
  const read = messages.filter((message) => message.role === "user");
  const last = read.at(-1)?.text ?? "";
  const count = /very slowly/i.test(last) ? 300 : /slowly/i.test(last) ? 60 : 8;
  return [
    ..."I have read".split(" "),
    String(read.length),
    read.length === 1 ? "message," : "messages,",
    ...Array.from({ length: count }, (_, index) => FILLER[index % FILLER.length]!),
  ];
}

// The tool calls a message asks for, by id with their input as sent.
function toolLines(text: string) {
  return [...text.matchAll(TOOL_LINE)].map(([, toolId, json]) => {
    let input: unknown = json;
    try {
      input = JSON.parse(json || "{}");
    } catch {
      // Sent as written, for the tool to refuse.
    }
    return { toolId: toolId!, input };
  });
}

function saidBy(result: ModelToolResult) {
  const said = result.output.ok
    ? `ok ${JSON.stringify(result.output.value)}`
    : `error ${result.output.error}`;
  return `Tool ${result.toolId} said: ${said}`;
}

export function createFakeGateway(): ModelGateway {
  return {
    async *stream(_token, request, signal) {
      const messages = [...request.messages];
      const offered = new Set((request.tools ?? []).map((tool) => tool.id));
      for (let step = 0; step < request.maxSteps; step += 1) {
        if (step > 0) {
          const added = request.beforeStep?.() ?? [];
          if (added.length === 0) return;
          messages.push(...added);
        }
        yield { type: "step-start" };
        const last = messages.at(-1);
        const said = last?.role === "user" ? last.text : "";
        if (/think/i.test(said)) {
          for (const [index, word] of REASONING.entries()) {
            await delay(WORD_MS, undefined, { signal });
            yield { type: "reasoning", text: index === 0 ? word : ` ${word}` };
          }
        }
        const scripted = last?.role === "user" ? SAY_LINE.exec(said) : null;
        if (scripted) {
          const text = scripted[1]!;
          for (let at = 0; at < text.length; at += SAY_CHARS) {
            await delay(WORD_MS, undefined, { signal });
            yield { type: "delta", text: text.slice(at, at + SAY_CHARS) };
          }
          messages.push({ role: "assistant", text });
          yield { type: "step-end", usage: { inputTokens: 10, outputTokens: text.length } };
          continue;
        }
        const wanted = toolLines(said);
        const words =
          last?.role === "tool"
            ? last.results.map(saidBy).join(" ").split(" ")
            : PROMPT_LINE.test(said)
              ? request.instructions.split(" ")
              : [
                  ...wordsFor(messages),
                  ...wanted
                    .filter(({ toolId }) => !offered.has(toolId))
                    .flatMap(({ toolId }) => `I cannot use ${toolId} here.`.split(" ")),
                ];
        for (const [index, word] of words.entries()) {
          await delay(WORD_MS, undefined, { signal });
          yield { type: "delta", text: index === 0 ? word : ` ${word}` };
        }
        const failure = last?.role === "user" ? FAIL_LINE.exec(said) : null;
        if (failure) throw new Error(failure[1]);
        const calls: ModelToolCall[] = wanted
          .filter(({ toolId }) => offered.has(toolId))
          .map((call) => ({ callId: ulid(), ...call }));
        for (const call of calls) yield { type: "tool-call", ...call };
        const text = words.join(" ");
        messages.push({ role: "assistant", text, toolCalls: calls });
        yield { type: "step-end", usage: { inputTokens: 10, outputTokens: words.length } };
        // The calls run elsewhere; the request ends with them.
        if (calls.length > 0) return;
      }
    },
  };
}

// The stand-in's list for a host: Echo and Echo Mini, and, for a host serving many makers, a model
// of another maker's by the ids that host gives, so their marks show. A key must start with `sk-`
// and other secrets must not start with `wrong`.
function fakeCatalog(host: HostId): Catalog {
  const many = !hostOf(host).maker;
  const others =
    host === "bedrock"
      ? [
          { id: "us.anthropic.claude-echo-5", name: "Claude Echo" },
          { id: "meta.llama-echo-v1:0", name: "Llama Echo" },
        ]
      : [{ id: "llama-echo", name: "Llama Echo" }];
  return {
    list(token) {
      const secrets = Object.values(token.secrets ?? {});
      if (
        (token.access && !token.access.startsWith("sk-")) ||
        (!token.access && secrets.length === 0)
      ) {
        return Promise.reject(new Error("401 invalid key"));
      }
      if (secrets.some((secret) => secret.startsWith("wrong"))) {
        return Promise.reject(new Error("403 invalid credentials"));
      }
      return Promise.resolve([
        { id: "echo", name: "Echo", reasoning: true },
        { id: "echo-mini", name: "Echo Mini", reasoning: false },
        ...(many ? others : []),
      ]);
    },
  };
}

// The stand-in's lists in place of every host's but the servers people run, whose lists are read.
export function createFakeCatalogs(real: Record<HostId, Catalog>) {
  return Object.fromEntries(
    HOST_IDS.map((host) => [
      host,
      hostOf(host).group === "self-hosted" ? real[host] : fakeCatalog(host),
    ]),
  ) as Record<HostId, Catalog>;
}
