// The test harness's model hosts: every org a test makes has the models the providers list, a
// thread's title request reaches the title model, and a workspace without titles names nothing.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import * as schema from "@/server/schema.ts";

import { setup } from "./workspace.ts";

type Listed = { models: { ref: string }[] };

describe("the harness's models", () => {
  it("are those of a team org too", async () => {
    const { api, signUp } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const { orgId } = (await (
      await api("POST", "/orgs", ada.cookie, { name: "Analytical Engines" })
    ).json()) as { orgId: string };

    const res = await api("GET", "/models", ada.cookie, undefined, orgId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Listed).models.map((model) => model.ref)).toEqual([
      "codex/gpt-big",
    ]);
  });

  it("are those of someone the directory provisions", async () => {
    const { scim, db, directory } = setup();
    await scim.createUser({ name: "Grace Hopper", email: "grace@example.com" });
    const grace = await directory.userByEmail("grace@example.com");
    const [member] = await db
      .select({ orgId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, grace!.id));

    const connections = await db
      .select({ host: schema.connection.host, authKind: schema.connection.authKind })
      .from(schema.connection)
      .where(eq(schema.connection.organizationId, member!.orgId));
    expect(connections).toEqual([{ host: "codex", authKind: "oauth" }]);
  });

  it("name a thread through the title model, and the agent replies through the other", async () => {
    const { api, signUp, yourSpace, createThread, models, model, titleModel, titledWith, worker } =
      setup({}, { titles: true });
    await models.default("codex/gpt-big");
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const thread = await createThread(ada.cookie, (await yourSpace(ada.cookie)).id);
    await worker.start();
    try {
      await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi" });
      const title = await titleModel.next();
      const reply = await model.next();
      expect(title.request.sessionId).toBe(`${thread.id}:title`);
      expect(reply.request.sessionId).toBe(thread.id);
      title.reply("Greetings");
      reply.reply("Hello");
      await worker.idle();
    } finally {
      await worker.stop();
    }
    expect(titledWith).toEqual(["codex/gpt-big"]);
  });

  it("name nothing without titles", async () => {
    const { api, signUp, yourSpace, createThread, model, titleModel, worker } = setup();
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const thread = await createThread(ada.cookie, (await yourSpace(ada.cookie)).id);
    await worker.start();
    try {
      await api("POST", `/threads/${thread.id}/messages`, ada.cookie, { text: "Hi" });
      (await model.next()).reply("Hello");
      await worker.idle();
    } finally {
      await worker.stop();
    }
    expect(titleModel.calls).toEqual([]);
  });
});
