// A stand-in model for the browser journeys, chosen by configuration and refused in production.
// It says how many messages from people it has read, then a few more words, one every few tens of
// milliseconds; it keeps going much longer when the newest message asks it to reply slowly, and
// reasons for a few words first when it asks it to think. Its list stands in for an API key's: it
// takes any key starting with `sk-`.

import { setTimeout as delay } from "node:timers/promises";

import type { Catalog } from "@/ports/catalog.ts";
import type { ModelGateway, ModelMessage } from "@/ports/model-gateway.ts";

export const FAKE_MODEL_REF = "fake/echo";

const WORD_MS = 40;
const FILLER = "and so the engine turns its wheels".split(" ");
const REASONING = "Considering the gears and the levers".split(" ");

function wordsFor(messages: ModelMessage[]) {
  const read = messages.filter((message) => message.role === "user");
  const count = /slowly/i.test(read.at(-1)?.text ?? "") ? 60 : 8;
  return [
    ..."I have read".split(" "),
    String(read.length),
    read.length === 1 ? "message," : "messages,",
    ...Array.from({ length: count }, (_, index) => FILLER[index % FILLER.length]!),
  ];
}

export function createFakeGateway(): ModelGateway {
  return {
    async *stream(_token, request, signal) {
      const messages = [...request.messages];
      for (let step = 0; step < request.maxSteps; step += 1) {
        if (step > 0) {
          const added = request.beforeStep?.() ?? [];
          if (added.length === 0) return;
          messages.push(...added);
        }
        yield { type: "step-start" };
        if (/think/i.test(messages.at(-1)?.text ?? "")) {
          for (const [index, word] of REASONING.entries()) {
            await delay(WORD_MS, undefined, { signal });
            yield { type: "reasoning", text: index === 0 ? word : ` ${word}` };
          }
        }
        const words = wordsFor(messages);
        for (const [index, word] of words.entries()) {
          await delay(WORD_MS, undefined, { signal });
          yield { type: "delta", text: index === 0 ? word : ` ${word}` };
        }
        const text = words.join(" ");
        messages.push({ role: "assistant", text });
        yield { type: "step-end", usage: { inputTokens: 10, outputTokens: words.length } };
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
