// A stand-in model provider: the script the in-process stand-in model follows, served over each
// wire protocol Mage's providers speak, so a connection pointed here goes through the real provider
// code. It answers any key and any model. Inference is told apart by the path's end, so a
// connection's base URL or proxy may put any prefix before it; model lists are by prefix, each
// answered in the shape the request asks for by its headers.

import { anthropic } from "./anthropic.ts";
import { gemini } from "./gemini.ts";
import { openaiChat } from "./openai-chat.ts";
import { openaiResponses } from "./openai-responses.ts";
import { reply } from "./wire.ts";

export interface ListedModel {
  id: string;
  name?: string;
  // Who made it, as OpenAI-compatible servers say.
  owner?: string;
}

export interface ModelsStandInOptions {
  // The models listed under each path prefix, such as `/v1` for a server people run.
  lists: Record<string, ListedModel[]>;
  // How long it waits before each piece it streams.
  pieceMs?: number;
}

const GEMINI = /\/models\/([^/:]+):streamGenerateContent$/;

function listed(req: Request, models: ListedModel[]) {
  if (req.headers.has("anthropic-version")) {
    return {
      data: models.map((model) => ({
        type: "model",
        id: model.id,
        display_name: model.name ?? model.id,
        created_at: "2026-01-01T00:00:00Z",
      })),
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models.at(-1)?.id ?? null,
    };
  }
  if (req.headers.has("x-goog-api-key")) {
    return {
      models: models.map((model) => ({
        name: `models/${model.id}`,
        displayName: model.name ?? model.id,
        supportedGenerationMethods: ["generateContent"],
      })),
    };
  }
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 1767225600,
      owned_by: model.owner ?? "stand-in",
    })),
  };
}

export function modelsStandIn(options: ModelsStandInOptions) {
  const pace = { pieceMs: options.pieceMs ?? 40 };
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path.endsWith("/models")) {
      const models = options.lists[path.slice(0, -"/models".length)];
      return models
        ? Response.json(listed(req, models))
        : new Response("Not found", { status: 404 });
    }
    if (req.method !== "POST") return new Response("Not found", { status: 404 });
    if (path.endsWith("/chat/completions")) return reply(openaiChat, req, pace);
    if (path.endsWith("/messages")) return reply(anthropic, req, pace);
    if (path.endsWith("/responses")) return reply(openaiResponses, req, pace);
    const model = GEMINI.exec(path)?.[1];
    if (model) return reply(gemini(decodeURIComponent(model)), req, pace);
    return new Response("Not found", { status: 404 });
  };
}
