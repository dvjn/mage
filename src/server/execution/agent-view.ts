// What a thread's agent reads besides the thread, kept until a reload, a compaction or a move;
// stored once under the hash of its JSON and read back from that JSON.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import type { ModelTool } from "@/server/models/gateway.ts";
import type { DeferredTool, ModelNames } from "@/server/tools/registry.ts";

import { agentView } from "./schema.ts";

export interface AgentView {
  instructions: string;
  tools: ModelTool[];
  searchable: ModelTool[];
  // The tool that turns searchable ones on, as the model knows it; empty when there is none.
  search: string;
  deferred: DeferredTool[];
  // Every tool of the space when taken, on or off, by id with its name for the model.
  names: [string, string][];
}

export function namesOf(view: Pick<AgentView, "names">): ModelNames {
  const toModel = new Map(view.names);
  const fromModel = new Map(view.names.map(([id, name]) => [name, id]));
  return {
    toModel: (id) => toModel.get(id) ?? id,
    fromModel: (name) => fromModel.get(name),
    known: (id) => toModel.has(id),
  };
}

export function hashOf(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

// About how many characters of views are kept in memory; each is never changed, so any kept is
// current.
const CACHED_CHARS = 20_000_000;

export type AgentViews = ReturnType<typeof createAgentViews>;

export function createAgentViews(db: Db) {
  // The least recently used first, each with its body's size.
  const cache = new Map<string, { view: AgentView; size: number }>();
  let size = 0;

  function remember(hash: string, view: AgentView, body: number) {
    const known = cache.get(hash);
    if (known) {
      cache.delete(hash);
      size -= known.size;
    }
    cache.set(hash, { view, size: body });
    size += body;
    for (const [oldest, kept] of cache) {
      if (size <= CACHED_CHARS || oldest === hash) break;
      cache.delete(oldest);
      size -= kept.size;
    }
    return view;
  }

  return {
    // Stores the view and answers its hash with the view as read back.
    async put(view: AgentView) {
      const body = JSON.stringify(view);
      const hash = hashOf(body);
      if (!cache.has(hash)) await db.insert(agentView).values({ hash, body }).onConflictDoNothing();
      return { hash, view: remember(hash, JSON.parse(body) as AgentView, body.length) };
    },

    async get(hash: string): Promise<AgentView | null> {
      const cached = cache.get(hash);
      if (cached) return remember(hash, cached.view, cached.size);
      const [row] = await db
        .select({ body: agentView.body })
        .from(agentView)
        .where(eq(agentView.hash, hash));
      return row ? remember(hash, JSON.parse(row.body) as AgentView, row.body.length) : null;
    },
  };
}
