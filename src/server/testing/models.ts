// Stand-in model hosts for the workspaces of one test database, and the knobs tests choose models
// with, written through the real stores. A model is named by its ref, `<prefix>/<id>`: `codex/…`
// comes through the ChatGPT sign-in every org is given, `claude/…` through an Anthropic key, and any
// other prefix through an OpenAI key named so; a key's connection has the prefix as its id, so it
// lives in one org only, the first given it unless a test names another. Each workspace's requests
// reach its own scripted models: a thread's title request its title model, the rest its reply model.

import { inArray } from "drizzle-orm";

import type { Systems } from "@/server/compose.ts";
import type { Db } from "@/server/db/db.ts";
import type { Cipher } from "@/server/kernel/cipher.ts";
import type { Catalog, CatalogModel } from "@/server/models/catalog.ts";
import { createModelChoiceStore } from "@/server/models/choice-store.ts";
import { createConnectionStore } from "@/server/models/connection-store.ts";
import { createCredentialStore } from "@/server/models/credential-store.ts";
import type { ModelGateway } from "@/server/models/gateway.ts";
import type { Models } from "@/server/models/service.ts";
import { orgSetting } from "@/server/orgs/schema.ts";
import * as schema from "@/server/schema.ts";
import { HOST_IDS, type HostId } from "@/shared/hosts.ts";
import type { Effort } from "@/shared/threads/thread.ts";

import type { scriptedModel } from "./scripted-model.ts";

// What the providers list, what each org chose, and who to tell, for every workspace on a database.
interface Providers {
  listed: string[];
  // Refs of models that take no effort.
  plain: Set<string>;
  off: string[];
  // The name each key connection goes by, by its prefix; a key without one goes by its host's.
  labels: Record<string, string | null>;
  defaultModel: string | null;
  defaultEffort: Effort | null;
  titleModel: string | null;
  // The orgs given models, in the order they were, with the person who made each.
  orgs: Map<string, string>;
  // Which org a key's connection is in, by its prefix.
  home: Map<string, string>;
  // The models services of the workspaces, whose lists are forgotten on every change.
  services: Set<Models>;
}

const everyDatabase = new WeakMap<object, Providers>();

const prefixOf = (ref: string) => ref.slice(0, ref.indexOf("/"));
const idOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);

// A key's host: the Anthropic key is named `claude`, every other is an OpenAI key.
const keyHost = (prefix: string): HostId => (prefix === "claude" ? "anthropic" : "openai");

// The sign-in's token never expires within a test.
const FOREVER = Date.UTC(2100, 0, 1);

export function standInModels(options: {
  database: object;
  db: Db;
  cipher: Cipher;
  model: ReturnType<typeof scriptedModel>;
  titleModel: ReturnType<typeof scriptedModel>;
  now: () => Date;
  // Waited on before each request reaches a model.
  before?: () => Promise<void>;
}) {
  const { db, model, titleModel, now } = options;
  let providers = everyDatabase.get(options.database);
  if (!providers) {
    providers = {
      listed: ["codex/gpt-big"],
      plain: new Set(),
      off: [],
      labels: {},
      defaultModel: null,
      defaultEffort: null,
      titleModel: null,
      orgs: new Map(),
      home: new Map(),
      services: new Set(),
    };
    everyDatabase.set(options.database, providers);
  }
  const state = providers;
  const connections = createConnectionStore(db);
  const credentials = createCredentialStore(db, options.cipher);
  const choices = createModelChoiceStore(db);
  // The model refs threads were named with.
  const titledWith: string[] = [];

  // A host lists the models of the connection the token is for: the sign-in's token and each key
  // are their prefix.
  const catalog: Catalog = {
    list: async (token) =>
      state.listed
        .filter((ref) => prefixOf(ref) === token.access)
        .map((ref): CatalogModel => ({
          id: idOf(ref),
          name: idOf(ref),
          reasoning: !state.plain.has(ref),
        })),
  };
  const gateway: ModelGateway = {
    async *stream(token, request, signal) {
      await options.before?.();
      const title = request.sessionId.endsWith(":title");
      if (title) titledWith.push(`${token.access}/${request.model}`);
      yield* (await (title ? titleModel : model).open()).stream(request, signal);
    },
  };
  const catalogs = Object.fromEntries(HOST_IDS.map((host) => [host, catalog])) as Record<
    HostId,
    Catalog
  >;
  const gateways = Object.fromEntries(HOST_IDS.map((host) => [host, gateway])) as Record<
    HostId,
    ModelGateway
  >;

  // The org's connections for the refs listed, made where missing, and its choices and settings
  // as the knobs say.
  async function seed(orgId: string) {
    const by = state.orgs.get(orgId)!;
    let list = await connections.list(orgId);
    if (!list.some((one) => one.authKind === "oauth" && one.host === "codex")) {
      const made = await connections.create({
        orgId,
        createdBy: by,
        host: "codex",
        authKind: "oauth",
        account: "ada@example.com",
      });
      await credentials.put(made.id, { access: "codex", refresh: "codex", expires: FOREVER });
      list = [...list, made];
    }
    for (const prefix of new Set(state.listed.map(prefixOf))) {
      if (prefix === "codex") continue;
      if (!state.home.has(prefix)) state.home.set(prefix, orgId);
      if (state.home.get(prefix) !== orgId) continue;
      const label =
        prefix in state.labels
          ? state.labels[prefix]!
          : keyHost(prefix) === "anthropic"
            ? null
            : prefix;
      const found = list.find((one) => one.id === prefix);
      if (!found) {
        await db.insert(schema.connection).values({
          id: prefix,
          organizationId: orgId,
          createdBy: by,
          host: keyHost(prefix),
          authKind: "api_key",
          account: `sk-…${prefix}`,
          label,
          settings: {},
        });
        await credentials.put(prefix, { apiKey: prefix });
      } else if (found.label !== label) {
        await connections.update(prefix, { label });
      }
    }
    for (const connection of await connections.list(orgId)) {
      const prefix = connection.authKind === "oauth" ? connection.host : connection.id;
      const ids = state.listed.filter((ref) => prefixOf(ref) === prefix).map(idOf);
      const off = ids.filter((id) => state.off.includes(`${prefix}/${id}`));
      await choices.set(connection.id, off, false, now());
      await choices.set(
        connection.id,
        ids.filter((id) => !off.includes(id)),
        true,
        now(),
      );
    }
    const settings = {
      defaultModel: state.defaultModel,
      defaultEffort: state.defaultEffort,
      titleModel: state.titleModel,
    };
    if (Object.values(settings).some((value) => value !== null)) {
      await db
        .insert(orgSetting)
        .values({ organizationId: orgId, ...settings })
        .onConflictDoUpdate({ target: orgSetting.organizationId, set: settings });
    }
  }

  // Every org given models brought to what the knobs now say, and every list read again.
  async function settle() {
    for (const orgId of state.orgs.keys()) await seed(orgId);
    const ids = state.orgs.size
      ? await db
          .select({ id: schema.connection.id })
          .from(schema.connection)
          .where(inArray(schema.connection.organizationId, [...state.orgs.keys()]))
      : [];
    for (const service of state.services) for (const { id } of ids) service.invalidate(id);
  }

  return {
    catalogs,
    gateways,
    titledWith,

    // Gives every org made from now on its models, and keeps this workspace's lists up to date.
    attach(systems: Pick<Systems, "hooks" | "models">) {
      state.services.add(systems.models);
      const given = async ({ orgId, userId }: { orgId: string; userId: string }) => {
        state.orgs.set(orgId, userId);
        await seed(orgId);
      };
      systems.hooks.on("person.signedUp", given);
      systems.hooks.on("org.created", given);
    },

    knobs: {
      // The providers list exactly these.
      async set(refs: readonly string[]) {
        state.listed = [...refs];
        await settle();
      },
      // The providers list these too; a key not given yet goes to the org named, else the first.
      async offer(refs: readonly string[], orgId?: string) {
        for (const ref of refs) {
          if (orgId && prefixOf(ref) !== "codex" && !state.home.has(prefixOf(ref))) {
            state.home.set(prefixOf(ref), orgId);
          }
        }
        state.listed = [...state.listed, ...refs.filter((ref) => !state.listed.includes(ref))];
        await settle();
      },
      // Listed as models that take no effort.
      async plain(refs: readonly string[]) {
        for (const ref of refs) state.plain.add(ref);
        state.listed = [...state.listed, ...refs.filter((ref) => !state.listed.includes(ref))];
        await settle();
      },
      // Exactly these are turned off.
      async off(refs: readonly string[]) {
        state.off = [...refs];
        await settle();
      },
      // The slug each connection goes by, by its prefix; a sign-in's is always its host's name.
      async slugs(slugs: Record<string, string>) {
        for (const [prefix, slug] of Object.entries(slugs)) {
          if (prefix === "codex") {
            if (slug !== "chatgpt") throw new Error("The ChatGPT sign-in goes by chatgpt");
            continue;
          }
          state.labels[prefix] = slug;
        }
        await settle();
      },
      async default(ref: string | null) {
        state.defaultModel = ref;
        await writeSettings({ defaultModel: ref });
      },
      async effort(effort: Effort | null) {
        state.defaultEffort = effort;
        await writeSettings({ defaultEffort: effort });
      },
      async titleModel(ref: string | null) {
        state.titleModel = ref;
        await writeSettings({ titleModel: ref });
      },
    },
  };

  async function writeSettings(
    changes: Partial<Pick<Providers, "defaultModel" | "defaultEffort" | "titleModel">>,
  ) {
    for (const orgId of state.orgs.keys()) {
      await db
        .insert(orgSetting)
        .values({ organizationId: orgId, ...changes })
        .onConflictDoUpdate({ target: orgSetting.organizationId, set: changes });
    }
  }
}

export type ModelKnobs = ReturnType<typeof standInModels>["knobs"];
