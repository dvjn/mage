// A stand-in model for the browser journeys, chosen by configuration and refused in production.
// It says how many messages from people it has read, then a few more words, one every few tens of
// milliseconds; it keeps going much longer when the newest message asks it to reply slowly, longer
// still very slowly, and
// reasons for a few words first when it asks it to think. Each `/tool <id> <json>` line in the
// newest message makes it call that tool after its words, when it is offered, or say it cannot;
// shown what the calls gave back, it says so. Its list stands in for an API key's: it takes any key
// starting with `sk-`.

import { setTimeout as delay } from "node:timers/promises";

import { ulid } from "ulid";

import type { Catalog } from "@/ports/catalog.ts";
import type { ModelMessage, ModelToolCall, ModelToolResult } from "@/ports/model-gateway.ts";
import type { ModelGateway } from "@/ports/model-gateway.ts";

export const FAKE_MODEL_REF = "fake/echo";

const WORD_MS = 40;
const FILLER = "and so the engine turns its wheels".split(" ");
const REASONING = "Considering the gears and the levers".split(" ");
// A line of a person's message, after the name it starts with.
const TOOL_LINE = /^(?:\[[^\]\n]*\][ \t]*)?\/tool[ \t]+(\S+)[ \t]*(.*)$/gm;

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
        const wanted = toolLines(said);
        const words =
          last?.role === "tool"
            ? last.results.map(saidBy).join(" ").split(" ")
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

export function createFakeCatalog(): Catalog {
  return {
    list(token) {
      if (!token.access.startsWith("sk-")) return Promise.reject(new Error("401 invalid key"));
      return Promise.resolve([
        { id: "echo", name: "Echo", reasoning: true },
        { id: "echo-mini", name: "Echo Mini", reasoning: false },
      ]);
    },
  };
}
