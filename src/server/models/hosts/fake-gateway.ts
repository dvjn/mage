// A stand-in model for the browser journeys, chosen by configuration and refused in production. Its
// script, which the mock's provider APIs share, says what it does at each step; this streams that
// as model events, a piece every few tens of milliseconds.
// Its lists stand in for hosts' lists: they take any key starting with `sk-`.

import { setTimeout as delay } from "node:timers/promises";

import { APICallError } from "ai";
import { ulid } from "ulid";

import { leads } from "@/server/execution/context.ts";
import type { Catalog } from "@/server/models/catalog.ts";
import {
  type ModelGateway,
  type ModelMessage,
  type ModelToolCall,
  ModelError,
} from "@/server/models/gateway.ts";
import { HOST_IDS, type HostId, hostOf } from "@/shared/hosts.ts";

import { modelErrorOf } from "./ai-sdk-stream.ts";
import { PIECE_MS, type ScriptStep, scriptStep } from "./fake-script.ts";

export const FAKE_MODEL_REF = "fake/echo";

// A refusal as a provider's response with that status, sorted as one would be.
function refusal(status: NonNullable<ScriptStep["status"]>) {
  const error = new APICallError({
    message: status.message,
    url: "stand-in://model",
    requestBodyValues: {},
    statusCode: status.code,
    responseHeaders: status.retryAfter === null ? {} : { "retry-after": String(status.retryAfter) },
    responseBody: JSON.stringify({ error: { message: status.message } }),
  });
  return modelErrorOf(error, { explains: (name) => name === "retry-after" });
}

export function createFakeGateway(): ModelGateway {
  return {
    async *stream(_token, request, signal) {
      // What changed in the thread it reads from its tools.
      const messages = request.messages.filter(
        (message): message is Exclude<ModelMessage, { role: "change" }> =>
          message.role !== "change",
      );
      const offered = new Set([
        ...(request.tools ?? []).map((tool) => tool.id),
        ...(request.toolsOn ?? []),
      ]);
      for (let step = 0; step < request.maxSteps; step += 1) {
        if (step > 0) {
          const added = (await request.beforeStep?.()) ?? [];
          if (added.length === 0) return;
          for (const message of added) if (message.role !== "change") messages.push(message);
        }
        const plan = scriptStep({
          instructions: request.instructions,
          messages,
          offered,
          search: request.search ?? "tools.search",
          isLead: leads,
        });
        if (plan.stall > 0) await delay(plan.stall, undefined, { signal });
        if (plan.status) throw refusal(plan.status);
        yield { type: "step-start" };
        for (const text of plan.reasoning) {
          await delay(PIECE_MS, undefined, { signal });
          yield { type: "reasoning", text };
        }
        for (const text of plan.text) {
          await delay(PIECE_MS, undefined, { signal });
          yield { type: "delta", text };
        }
        if (plan.drop) throw new ModelError("network", "The connection closed mid-reply");
        if (plan.fail !== null) throw new Error(plan.fail);
        const calls: ModelToolCall[] = plan.calls.map(({ toolId, input }) => ({
          callId: ulid(),
          toolId,
          input,
        }));
        for (const call of calls) yield { type: "tool-call", ...call };
        messages.push({ role: "assistant", text: plan.text.join(""), toolCalls: calls });
        yield { type: "step-end", usage: plan.usage };
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
