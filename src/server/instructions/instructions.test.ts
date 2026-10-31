import { describe, expect, it } from "vite-plus/test";

import { instructionsFor } from "@/server/agent/context.ts";
import type { Instructions, SpaceInstructions } from "@/shared/instructions.ts";
import { agentThread } from "@/server/testing/agent-thread.ts";
import { setup } from "@/server/testing/workspace.ts";

async function json<T>(res: Response, status = 200) {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

describe("the system prompt", () => {
  it("is Mage's prompt, then the org's instructions, then the space's", () => {
    const prompt = instructionsFor(["Ada"], { org: "Be brief.", space: "Use British spelling." });
    const at = (text: string) => prompt.indexOf(text);
    expect(at("You are the agent in Mage")).toBe(0);
    expect(at("Instructions from the organization:\nBe brief.")).toBeGreaterThan(0);
    expect(at("Instructions from this space:\nUse British spelling.")).toBeGreaterThan(
      at("Be brief."),
    );
  });

  it("leaves out what is empty", () => {
    const prompt = instructionsFor(["Ada"], { org: " ", space: "" });
    expect(prompt).toBe(instructionsFor(["Ada"]));
    expect(prompt).not.toContain("Instructions");
  });
});

describe("instructions", () => {
  it("are the org owners' to change in the org, read by its members, and a space's managers'", async () => {
    const workspace = setup();
    const { api, signUp, join } = workspace;
    const ada = await signUp("Ada Lovelace", "ada@example.com");
    const space = await workspace.yourSpace(ada.cookie);
    const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");

    const refused = await api("PUT", "/org/instructions", grace.cookie, { text: "Hi" }, ada.orgId);
    expect(refused.status).toBe(403);
    await json(await api("PUT", "/org/instructions", ada.cookie, { text: " Be brief. " }));
    const read = await json<Instructions>(
      await api("GET", "/org/instructions", grace.cookie, undefined, ada.orgId),
    );
    expect(read.text).toBe("Be brief.");
    const long = await api("PUT", "/org/instructions", ada.cookie, { text: "x".repeat(50_001) });
    expect(long.status).toBe(400);

    const own = await api("PUT", `/spaces/${space.id}/instructions`, grace.cookie, { text: "Hi" });
    expect(own.status).toBe(403);
    const saved = await json<SpaceInstructions>(
      await api("PUT", `/spaces/${space.id}/instructions`, ada.cookie, { text: "Cite ids." }),
    );
    expect([saved.own.text, saved.org.text]).toEqual(["Cite ids.", "Be brief."]);
  });

  it("reach the agent in its prompt, the org's before the space's", async () => {
    const { ada, api, post, model, worker, start, thread } = await agentThread();
    await json(await api("PUT", "/org/instructions", ada.cookie, { text: "Be brief." }));
    await json(
      await api("PUT", `/spaces/${thread.spaceId}/instructions`, ada.cookie, { text: "Cite ids." }),
    );
    start();
    await post(ada, "Hello");
    const call = await model.next();
    call.reply("Hi.");
    await worker.idle();
    expect(call.request.instructions).toContain(
      "Instructions from the organization:\nBe brief.\n\nInstructions from this space:\nCite ids.",
    );
  });
});
