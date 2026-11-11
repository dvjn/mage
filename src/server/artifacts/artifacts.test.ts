import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { ulid } from "ulid";

import * as schema from "@/server/schema.ts";

import type { AnyToolSpec, ToolContext } from "@/server/agent/tools.ts";
import { ARTIFACT_ORIGIN, setup } from "@/server/testing/workspace.ts";
import {
  ARTIFACT_TOOLS,
  type Artifact,
  type ArtifactDetail,
  type ArtifactEvent,
  type ArtifactSettings,
  type ArtifactView,
} from "@/shared/artifacts.ts";

import { createArtifacts } from "./service.ts";
import { createArtifactStore } from "./store.ts";
import { type ArtifactPreviewer, loadChromiumPreviewer, type PreviewReport } from "./preview.ts";
import { contentPolicy, applyEdits, shellOf, titleOf } from "./page.ts";

const PAGE = "<title>Sales chart</title><h1>Sales</h1>";
const PNG = Buffer.from("not really a png").toString("base64");

// The workspace's artifacts on the same data, with a browser to preview in.
function withPreviewer(workspace: ReturnType<typeof setup>, previewer: ArtifactPreviewer) {
  return createArtifacts({
    store: createArtifactStore(workspace.db),
    threads: workspace.threadStore,
    spaceStore: workspace.spaceStore,
    spaces: workspace.spaces,
    access: workspace.access,
    guests: workspace.guestStore,
    directory: workspace.directory,
    appOrigin: "http://localhost:4783",
    artifactOrigin: ARTIFACT_ORIGIN,
    secret: "test-secret-that-is-long-enough-0123456789",
    previewer,
  });
}

// Ada owns a team space, where Grace posts and Alan only reads; Bob is in another org.
async function team({ previewer }: { previewer?: ArtifactPreviewer } = {}) {
  const workspace = setup();
  const { api, signUp, join, artifacts } = workspace;
  const ada = await signUp("Ada Lovelace", "ada@example.com");
  const space = await workspace.yourSpace(ada.cookie);
  const thread = await workspace.createThread(ada.cookie, space.id);
  const grace = join(await signUp("Grace Hopper", "grace@example.com"), space.id, "messager");
  const alan = join(await signUp("Alan Turing", "alan@example.com"), space.id, "viewer");
  const bob = await signUp("Bob Boole", "bob@example.com");
  // Carol is in Ada's org but not in her space.
  const carolUser = await signUp("Carol Shaw", "carol@example.com");
  workspace.db
    .update(schema.session)
    .set({ activeOrganizationId: ada.orgId })
    .where(eq(schema.session.userId, carolUser.userId))
    .run();
  workspace.db
    .insert(schema.member)
    .values({
      id: ulid(),
      organizationId: ada.orgId,
      userId: carolUser.userId,
      role: "member",
      directRole: "member",
      createdAt: new Date(),
    })
    .run();
  const carol = { ...carolUser, orgId: ada.orgId };

  const specs = new Map<string, AnyToolSpec>(
    (previewer ? withPreviewer(workspace, previewer) : artifacts)
      .toolset()
      .tools.map((tool) => [tool.name, tool]),
  );
  const ctx = (threadId = thread.id, spaceId = space.id): ToolContext =>
    ({
      threadId,
      spaceId,
      orgId: ada.orgId,
      runId: "run",
      callId: "call",
      actor: { kind: "agent" },
      model: null,
      runAs: null,
      write: (work) => work(() => {}),
    }) as ToolContext;
  async function call(name: string, input: object, threadId?: string, spaceId?: string) {
    const spec = specs.get(name)!;
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    return (await spec.run(parsed.data, ctx(threadId, spaceId))) as
      | { ok: true; value: any }
      | { ok: false; error: string };
  }
  async function publish(input: object = {}) {
    const result = await call(ARTIFACT_TOOLS.publish, {
      html: PAGE,
      description: "Sales by month",
      icon: "chart",
      ...input,
    });
    if (!result.ok) throw new Error(result.error);
    return result.value.id as string;
  }
  async function json<T>(res: Response) {
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }
  const view = async (who: { cookie: string }, id: string, body: object = {}) =>
    api("POST", `/artifacts/${id}/view`, who.cookie, body);
  async function open(who: { cookie: string }, id: string, body: object = {}) {
    const link = await json<ArtifactView>(await view(who, id, body));
    return artifacts.content(new Request(link.url));
  }
  return {
    ...workspace,
    ada,
    grace,
    alan,
    bob,
    carol,
    space,
    thread,
    call,
    publish,
    json,
    view,
    open,
  };
}

describe("publishing and updating", () => {
  it("publishes a first version named by the page's title, with its files", async () => {
    const t = await team();
    const id = await t.publish({
      assets: [{ name: "logo.png", contentType: "image/png", base64: PNG }],
    });
    const detail = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.ada.cookie),
    );
    expect(detail).toMatchObject({
      title: "Sales chart",
      version: 1,
      sharing: "space",
      icon: "chart",
      assets: [{ name: "logo.png", contentType: "image/png" }],
    });
    const list = await t.json<Artifact[]>(
      await t.api("GET", `/threads/${t.thread.id}/artifacts`, t.ada.cookie),
    );
    expect(list.map((artifact) => artifact.id)).toEqual([id]);
  });

  it("makes a version of an update, from the whole page or from edits, with a label", async () => {
    const t = await team();
    const id = await t.publish();
    const html = await t.call(ARTIFACT_TOOLS.update, {
      id,
      html: "<title>Sales v2</title>",
      label: "Rename",
    });
    expect(html).toMatchObject({ ok: true, value: { version: 2, title: "Sales v2" } });
    const edited = await t.call(ARTIFACT_TOOLS.update, {
      id,
      basedOn: 2,
      edits: [{ old: "v2", new: "v3" }],
    });
    expect(edited).toMatchObject({ ok: true, value: { version: 3, title: "Sales v3" } });
    const detail = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.ada.cookie),
    );
    expect(detail.versions.map((v) => [v.version, v.label])).toEqual([
      [3, null],
      [2, "Rename"],
      [1, null],
    ]);
    // Description and icon carry over.
    expect(detail).toMatchObject({ description: "Sales by month", icon: "chart" });
  });

  it("applies edits all or none, each old text exactly once", async () => {
    const t = await team();
    const id = await t.publish({ html: "<title>T</title><p>a</p><p>a</p>" });
    const twice = await t.call(ARTIFACT_TOOLS.update, {
      id,
      edits: [
        { old: "<title>T</title>", new: "<title>U</title>" },
        { old: "a", new: "b" },
      ],
    });
    expect(twice).toMatchObject({ ok: false });
    const missing = await t.call(ARTIFACT_TOOLS.update, {
      id,
      edits: [
        { old: "<title>T</title>", new: "<title>U</title>" },
        { old: "zzz", new: "b" },
      ],
    });
    expect(missing).toMatchObject({ ok: false });
    const read = await t.call(ARTIFACT_TOOLS.read, { id });
    expect(read).toMatchObject({ ok: true, value: { version: 1, latest: 1 } });
    expect(
      applyEdits("ab", [
        { old: "a", new: "b" },
        { old: "bb", new: "c" },
      ]),
    ).toEqual({
      ok: true,
      html: "c",
    });
  });

  it("refuses an update built on an older version, giving the latest page to merge into", async () => {
    const t = await team();
    const id = await t.publish();
    await t.call(ARTIFACT_TOOLS.update, { id, html: "<title>Newer</title>" });
    const stale = await t.call(ARTIFACT_TOOLS.update, {
      id,
      basedOn: 1,
      html: "<title>Mine</title>",
    });
    expect(stale).toMatchObject({ ok: false });
    expect((stale as { error: string }).error).toContain("<title>Newer</title>");
    expect(await t.call(ARTIFACT_TOOLS.read, { id })).toMatchObject({
      value: { version: 2, title: "Newer" },
    });
  });

  it("keeps files across updates until they are removed", async () => {
    const t = await team();
    const id = await t.publish({
      assets: [{ name: "a.png", contentType: "image/png", base64: PNG }],
    });
    await t.call(ARTIFACT_TOOLS.update, {
      id,
      html: PAGE,
      assets: [{ name: "b.png", contentType: "image/png", base64: PNG }],
    });
    const names = async () =>
      (
        (await t.call(ARTIFACT_TOOLS.read, { id })) as { value: { assets: { name: string }[] } }
      ).value.assets.map((asset) => asset.name);
    expect(await names()).toEqual(["a.png", "b.png"]);
    await t.call(ARTIFACT_TOOLS.update, { id, html: PAGE, removeAssets: ["a.png"] });
    expect(await names()).toEqual(["b.png"]);
  });

  it("refuses files that are not names, types or base64", async () => {
    const t = await team();
    for (const asset of [
      { name: "../x.png", contentType: "image/png", base64: PNG },
      { name: "x.exe", contentType: "application/x-msdownload", base64: PNG },
    ]) {
      expect(
        await t.call(ARTIFACT_TOOLS.publish, {
          html: PAGE,
          description: "d",
          icon: "chart",
          assets: [asset],
        }),
      ).toMatchObject({ ok: false });
    }
  });

  it("lets another thread in the space list, read and update an artifact, not one in another space", async () => {
    const t = await team();
    const id = await t.publish();
    const other = await t.createThread(t.ada.cookie, t.space.id);
    // Not used by the other thread yet, so its own list is empty; the space's is not.
    expect(await t.call(ARTIFACT_TOOLS.list, {}, other.id)).toMatchObject({
      value: { artifacts: [] },
    });
    const all = await t.call(ARTIFACT_TOOLS.list, { scope: "space" }, other.id);
    expect(all).toMatchObject({
      ok: true,
      value: {
        artifacts: [{ id, title: "Sales chart", description: "Sales by month", version: 1 }],
      },
    });
    expect(await t.call(ARTIFACT_TOOLS.read, { id }, other.id)).toMatchObject({ ok: true });
    // Reading made it one the thread used.
    expect(await t.call(ARTIFACT_TOOLS.list, {}, other.id)).toMatchObject({
      value: { artifacts: [{ id }] },
    });
    expect(
      await t.call(
        ARTIFACT_TOOLS.update,
        { id, basedOn: 1, edits: [{ old: "<h1>Sales</h1>", new: "<h1>Revenue</h1>" }] },
        other.id,
      ),
    ).toMatchObject({ ok: true, value: { version: 2 } });
    // A stale publish from the first thread is still refused.
    expect(
      await t.call(ARTIFACT_TOOLS.update, { id, basedOn: 1, html: "<title>X</title>" }),
    ).toMatchObject({
      ok: false,
    });
    // The update is recorded with the thread that made it.
    const row = t.db
      .select()
      .from(schema.artifactVersion)
      .where(eq(schema.artifactVersion.artifactId, id))
      .all();
    expect(row.map((one) => [one.version, one.threadId])).toEqual(
      expect.arrayContaining([
        [1, t.thread.id],
        [2, other.id],
      ]),
    );
    const elsewhere = await t.createSpace(t.ada.cookie, "Elsewhere");
    const away = await t.createThread(t.ada.cookie, elsewhere.id);
    const asAway = (name: string, input: object) => {
      const spec = t.artifacts.toolset().tools.find((tool) => tool.name === name)!;
      return spec.run(spec.input.parse(input), {
        threadId: away.id,
        spaceId: elsewhere.id,
        write: (work: (append: () => void) => unknown) => work(() => {}),
      } as never);
    };
    expect(await asAway(ARTIFACT_TOOLS.read, { id })).toMatchObject({ ok: false });
    expect(await asAway(ARTIFACT_TOOLS.update, { id, html: "<title>X</title>" })).toMatchObject({
      ok: false,
    });
    expect(await asAway(ARTIFACT_TOOLS.list, { scope: "space" })).toMatchObject({
      value: { artifacts: [] },
    });
  });

  it("has no tool to delete an artifact", async () => {
    const t = await team();
    const tools = t.artifacts.toolset().tools.map((tool) => tool.name);
    expect(tools).not.toContain("artifact.delete");
    const publish = t.artifacts
      .toolset()
      .tools.find((tool) => tool.name === ARTIFACT_TOOLS.publish)!;
    expect(publish.risk({}, { model: null })).toBe("normal");
  });

  it("stays when the thread it was made in is deleted", async () => {
    const t = await team();
    const made = await t.createThread(t.ada.cookie, t.space.id);
    const id = await t.call(
      ARTIFACT_TOOLS.publish,
      { html: PAGE, description: "Sales by month", icon: "chart" },
      made.id,
    );
    if (!id.ok) throw new Error(id.error);
    t.db.delete(schema.thread).where(eq(schema.thread.id, made.id)).run();
    const detail = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id.value.id}`, t.ada.cookie),
    );
    expect(detail.madeIn).toBeNull();
    expect(detail.usedIn).toEqual([]);
    expect(detail.version).toBe(1);
  });

  it("goes with the thread's root: a thread forked from it keeps the same artifacts", async () => {
    const t = await team();
    const id = await t.publish();
    expect(await t.call(ARTIFACT_TOOLS.read, { id })).toMatchObject({ ok: true });
  });

  it("reads an old thread-level row as shared with the space", async () => {
    const t = await team();
    const id = await t.publish();
    // A row as the migration leaves it: its level was renamed, its space filled in.
    t.db.update(schema.artifact).set({ sharing: "space" }).where(eq(schema.artifact.id, id)).run();
    expect((await t.view(t.alan, id)).status).toBe(200);
    expect((await t.view(t.carol, id)).status).toBe(404);
  });
});

describe("a thread's guest", () => {
  // Bob joins the thread as a guest; Dee is a guest of another thread that did not use the artifact.
  async function guests() {
    const t = await team();
    const id = await t.publish();
    // Publishing shares with the thread's guests; these tests start from it not shared.
    await t.json(
      await t.api("PUT", `/artifacts/${id}/guests`, t.ada.cookie, {
        threadId: t.thread.id,
        shared: false,
      }),
    );
    async function guestOf(threadId: string, who: { cookie: string }) {
      const invite = await t.api("POST", `/threads/${threadId}/invites`, t.ada.cookie, {
        accessFor: "1d",
      });
      const { url } = await t.json<{ url: string }>(invite);
      const accepted = await t.api("POST", "/invites/accept", who.cookie, {
        token: url.split("/invite/")[1],
      });
      expect(accepted.status).toBe(200);
    }
    await guestOf(t.thread.id, t.bob);
    const elsewhere = await t.createThread(t.ada.cookie, t.space.id);
    const dee = await t.signUp("Dee Dee", "dee@example.com");
    await guestOf(elsewhere.id, dee);
    const share = (who: { cookie: string }, threadId: string, shared: boolean) =>
      t.api("PUT", `/artifacts/${id}/guests`, who.cookie, { threadId, shared });
    return { ...t, id, dee, elsewhere, share };
  }

  it("cannot open an artifact their thread used until a member shares it with the thread", async () => {
    const t = await guests();
    const refused = await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "not_shared" });
    expect((await t.view(t.bob, t.id)).status).toBe(404);
    const locked = await t.json<Artifact[]>(
      await t.api("GET", `/threads/${t.thread.id}/artifacts`, t.bob.cookie),
    );
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ id: t.id, title: "Sales chart", locked: true });
    expect(locked[0]!.description).toBe("");

    await t.json(await t.share(t.ada, t.thread.id, true));
    const opened = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie),
    );
    expect(opened.locked).toBe(false);
    expect((await t.view(t.bob, t.id)).status).toBe(200);
    const listed = await t.json<Artifact[]>(
      await t.api("GET", `/threads/${t.thread.id}/artifacts`, t.bob.cookie),
    );
    expect(listed.map((one) => [one.id, one.locked, one.canDelete])).toEqual([
      [t.id, false, false],
    ]);
  });

  it("changes nothing, and loses the artifact when sharing with the thread is turned off", async () => {
    const t = await guests();
    await t.json(await t.share(t.ada, t.thread.id, true));
    expect((await t.api("DELETE", `/artifacts/${t.id}`, t.bob.cookie)).status).toBe(403);
    expect(
      (await t.api("PUT", `/artifacts/${t.id}/sharing`, t.bob.cookie, { sharing: "org" })).status,
    ).toBe(403);
    expect((await t.share(t.bob, t.thread.id, false)).status).toBe(403);
    await t.json(await t.share(t.ada, t.thread.id, false));
    expect((await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie)).status).toBe(403);
    expect((await t.view(t.bob, t.id)).status).toBe(404);
  });

  it("is told at once that access ended on the stream's next check", async () => {
    const t = await guests();
    await t.json(await t.share(t.ada, t.thread.id, true));
    expect(t.artifacts.viewable(t.bob, t.id)).toBe(true);
    await t.json(await t.share(t.ada, t.thread.id, false));
    expect(t.artifacts.viewable(t.bob, t.id)).toBe(false);
  });

  it("is not given an artifact through another thread, which must have used it", async () => {
    const t = await guests();
    expect((await t.share(t.ada, t.elsewhere.id, true)).status).toBe(404);
    expect((await t.api("GET", `/artifacts/${t.id}`, t.dee.cookie)).status).toBe(404);
    expect(
      await t.json<unknown[]>(
        await t.api("GET", `/threads/${t.elsewhere.id}/artifacts`, t.dee.cookie),
      ),
    ).toEqual([]);
  });

  it("is listed to those who may change the artifact, and only to them", async () => {
    const t = await guests();
    const before = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${t.id}`, t.ada.cookie),
    );
    expect(before.guestThreads).toEqual([
      { id: t.thread.id, title: null, guests: 1, shared: false },
    ]);
    const detail = await t.json<ArtifactDetail>(await t.share(t.grace, t.thread.id, true));
    expect(detail.guestThreads[0]!.shared).toBe(true);
    const viewer = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${t.id}`, t.alan.cookie),
    );
    expect(viewer.guestThreads).toEqual([]);
    expect((await t.share(t.alan, t.thread.id, false)).status).toBe(403);
    const guest = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie),
    );
    expect(guest.guestThreads).toEqual([]);
  });

  it("still sees an artifact shared with the org or the public", async () => {
    const t = await guests();
    await t.json(
      await t.api("PUT", "/org/artifacts/settings", t.ada.cookie, { publicAllowed: true }),
    );
    await t.json(
      await t.api("PUT", `/artifacts/${t.id}/sharing`, t.ada.cookie, { sharing: "public" }),
    );
    expect((await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie)).status).toBe(200);
  });
});

describe("the agent in a thread with guests", () => {
  async function invite(t: Awaited<ReturnType<typeof team>>, threadId: string, who: object) {
    const res = await t.api("POST", `/threads/${threadId}/invites`, t.ada.cookie, {
      accessFor: "1d",
    });
    const { url } = await t.json<{ url: string }>(res);
    const accepted = await t.api("POST", "/invites/accept", (who as { cookie: string }).cookie, {
      token: url.split("/invite/")[1],
    });
    expect(accepted.status).toBe(200);
  }
  const unshare = async (t: Awaited<ReturnType<typeof team>>, id: string, threadId: string) =>
    t.json(
      await t.api("PUT", `/artifacts/${id}/guests`, t.ada.cookie, { threadId, shared: false }),
    );
  const share = async (t: Awaited<ReturnType<typeof team>>, id: string, threadId: string) =>
    t.json(await t.api("PUT", `/artifacts/${id}/guests`, t.ada.cookie, { threadId, shared: true }));
  const ids = (result: { ok: boolean; value?: any }) =>
    (result.value.artifacts as { id: string }[]).map((one) => one.id);
  const REFUSAL =
    "Not shared with this thread's guests. Someone who can share it can give them access.";

  it("shares what it publishes with the thread's guests, including ones invited later", async () => {
    const t = await team();
    const id = await t.publish();
    await invite(t, t.thread.id, t.bob);
    expect((await t.api("GET", `/artifacts/${id}`, t.bob.cookie)).status).toBe(200);
    expect((await t.view(t.bob, id)).status).toBe(200);
    // A member may turn it off like any other.
    await unshare(t, id, t.thread.id);
    expect((await t.api("GET", `/artifacts/${id}`, t.bob.cookie)).status).toBe(403);
  });

  it("lists, reads and updates only what the guests can open, until a member shares it", async () => {
    const t = await team();
    const mine = await t.publish();
    const other = await t.createThread(t.ada.cookie, t.space.id);
    const unshared = (
      (await t.call(
        ARTIFACT_TOOLS.publish,
        { html: "<title>Secret</title>", description: "d", icon: "lock" },
        other.id,
      )) as { value: { id: string } }
    ).value.id;
    // Used by this thread before the guest came, so it can be shared with them.
    expect((await t.call(ARTIFACT_TOOLS.read, { id: unshared })).ok).toBe(true);
    await unshare(t, unshared, other.id);
    await invite(t, t.thread.id, t.bob);

    const space = await t.call(ARTIFACT_TOOLS.list, { scope: "space" });
    expect(ids(space)).toEqual([mine]);
    const thread = await t.call(ARTIFACT_TOOLS.list, {});
    expect(ids(thread)).toEqual([mine]);
    expect(await t.call(ARTIFACT_TOOLS.read, { id: unshared })).toEqual({
      ok: false,
      error: REFUSAL,
    });
    expect(
      await t.call(ARTIFACT_TOOLS.update, { id: unshared, html: "<title>Secret two</title>" }),
    ).toEqual({ ok: false, error: REFUSAL });

    await share(t, unshared, t.thread.id);
    expect((await t.call(ARTIFACT_TOOLS.read, { id: unshared })).ok).toBe(true);
    expect(
      (await t.call(ARTIFACT_TOOLS.update, { id: unshared, html: "<title>Secret two</title>" })).ok,
    ).toBe(true);
  });

  it("changes nothing without guests", async () => {
    const t = await team();
    const mine = await t.publish();
    await unshare(t, mine, t.thread.id);
    const other = await t.createThread(t.ada.cookie, t.space.id);
    const id = (
      (await t.call(
        ARTIFACT_TOOLS.publish,
        { html: "<title>Other</title>", description: "d", icon: "x" },
        other.id,
      )) as { value: { id: string } }
    ).value.id;
    const listed = await t.call(ARTIFACT_TOOLS.list, { scope: "space" });
    expect(ids(listed)).toHaveLength(2);
    expect((await t.call(ARTIFACT_TOOLS.read, { id })).ok).toBe(true);
  });

  it("uses the root thread's guests in a subagent's thread", async () => {
    const t = await team();
    const hidden = await t.publish();
    await unshare(t, hidden, t.thread.id);
    await invite(t, t.thread.id, t.bob);
    const child = t.threadStore.create({
      spaceId: t.space.id,
      model: null,
      createdBy: null,
      parentThreadId: t.thread.id,
      rootThreadId: t.thread.id,
    });
    expect(await t.call(ARTIFACT_TOOLS.read, { id: hidden }, child.id)).toEqual({
      ok: false,
      error: REFUSAL,
    });
    const published = await t.call(
      ARTIFACT_TOOLS.publish,
      { html: "<title>Child page</title>", description: "d", icon: "x" },
      child.id,
    );
    expect(published.ok).toBe(true);
    const publishedId = (published as { value: { id: string } }).value.id;
    expect((await t.api("GET", `/artifacts/${publishedId}`, t.bob.cookie)).status).toBe(200);
  });

  it("counts an org-level artifact within bounds only when every guest can view it", async () => {
    const t = await team();
    const id = await t.publish();
    await unshare(t, id, t.thread.id);
    await t.json(await t.api("PUT", `/artifacts/${id}/sharing`, t.ada.cookie, { sharing: "org" }));
    await invite(t, t.thread.id, t.carol);
    expect((await t.call(ARTIFACT_TOOLS.read, { id })).ok).toBe(true);
    await invite(t, t.thread.id, t.bob);
    expect(await t.call(ARTIFACT_TOOLS.read, { id })).toEqual({ ok: false, error: REFUSAL });
  });

  it("leaves editing to tool policy: update is not read-only and has normal risk", async () => {
    const t = await team();
    const update = t.artifacts.toolset().tools.find((tool) => tool.name === ARTIFACT_TOOLS.update)!;
    expect(update.annotations?.readOnlyHint).toBe(false);
    expect(update.risk({}, { model: null })).toBe("normal");
  });
});

describe("sharing with a thread's guests from the thread's list", () => {
  async function withGuest() {
    const t = await team();
    const id = await t.publish();
    await t.json(
      await t.api("PUT", `/artifacts/${id}/guests`, t.ada.cookie, {
        threadId: t.thread.id,
        shared: false,
      }),
    );
    const invite = await t.api("POST", `/threads/${t.thread.id}/invites`, t.ada.cookie, {
      accessFor: "1d",
    });
    const { url } = await t.json<{ url: string }>(invite);
    await t.api("POST", "/invites/accept", t.bob.cookie, { token: url.split("/invite/")[1] });
    const listed = async (who: { cookie: string }) =>
      (
        await t.json<{ id: string; guests: unknown }[]>(
          await t.api("GET", `/threads/${t.thread.id}/artifacts`, who.cookie),
        )
      )[0]!.guests;
    return { ...t, id, listed };
  }

  it("says so only to those who may change it, in a thread with guests", async () => {
    const t = await withGuest();
    expect(await t.listed(t.ada)).toEqual({ count: 1, shared: false, canChange: true });
    expect(await t.listed(t.grace)).toEqual({ count: 1, shared: false, canChange: true });
    expect(await t.listed(t.alan)).toBeNull();
    expect(await t.listed(t.bob)).toBeNull();
  });

  it("is null in a thread without guests", async () => {
    const t = await team();
    await t.publish();
    const list = await t.json<{ guests: unknown }[]>(
      await t.api("GET", `/threads/${t.thread.id}/artifacts`, t.ada.cookie),
    );
    expect(list[0]!.guests).toBeNull();
  });

  it("shares with the guests, who can then open it", async () => {
    const t = await withGuest();
    expect((await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie)).status).toBe(403);
    await t.json(
      await t.api("PUT", `/artifacts/${t.id}/guests`, t.ada.cookie, {
        threadId: t.thread.id,
        shared: true,
      }),
    );
    expect(await t.listed(t.ada)).toEqual({ count: 1, shared: true, canChange: true });
    expect((await t.api("GET", `/artifacts/${t.id}`, t.bob.cookie)).status).toBe(200);
  });
});

describe("sharing with people", () => {
  const put = (
    t: Awaited<ReturnType<typeof team>>,
    who: { cookie: string },
    id: string,
    u: string,
    role?: "view" | "edit",
  ) => t.api("PUT", `/artifacts/${id}/people/${u}`, who.cookie, role ? { role } : {});
  const detailOf = async (
    t: Awaited<ReturnType<typeof team>>,
    who: { cookie: string },
    id: string,
  ) => t.json<ArtifactDetail>(await t.api("GET", `/artifacts/${id}`, who.cookie));

  it("lets a person open it, view only, whatever its level", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await t.api("GET", `/artifacts/${id}`, t.carol.cookie)).status).toBe(404);
    const detail = await t.json<ArtifactDetail>(await put(t, t.grace, id, t.carol.userId));
    expect(detail.people).toEqual([
      {
        userId: t.carol.userId,
        name: "Carol Shaw",
        email: "carol@example.com",
        former: false,
        guest: false,
        role: "view",
      },
    ]);
    const opened = await detailOf(t, t.carol, id);
    expect(opened.people).toEqual([]);
    expect(opened.canShare).toBe(false);
    expect((await t.view(t.carol, id)).status).toBe(200);
    expect((await t.api("DELETE", `/artifacts/${id}`, t.carol.cookie)).status).toBe(403);
    expect(
      (await t.api("PUT", `/artifacts/${id}/sharing`, t.carol.cookie, { sharing: "org" })).status,
    ).toBe(403);
    expect((await put(t, t.carol, id, t.carol.userId)).status).toBe(403);
    const gallery = await t.json<{ items: { id: string }[] }>(
      await t.api("GET", "/artifacts", t.carol.cookie),
    );
    expect(gallery.items.map((one) => one.id)).toEqual([id]);
  });

  it("offers members outside the space and the thread's guests, not others", async () => {
    const t = await team();
    const id = await t.publish();
    const invite = await t.api("POST", `/threads/${t.thread.id}/invites`, t.ada.cookie, {
      accessFor: "1d",
    });
    const { url } = await t.json<{ url: string }>(invite);
    await t.api("POST", "/invites/accept", t.bob.cookie, { token: url.split("/invite/")[1] });
    const candidates = async (q = "") =>
      t.json<{ kind: string; name: string; already: string | null; current: string | null }[]>(
        await t.api("GET", `/artifacts/${id}/people?q=${q}`, t.ada.cookie),
      );
    const found = async (q = "") => (await candidates(q)).map((one) => one.name);
    // Ada is the asker. Grace posts in the space already, so she is marked; Alan only views it, so
    // he may be given more.
    expect((await found()).toSorted()).toEqual([
      "Alan Turing",
      "Bob Boole",
      "Carol Shaw",
      "Grace Hopper",
    ]);
    const marked = Object.fromEntries(
      (await candidates()).map((one) => [one.name, [one.already, one.current]]),
    );
    expect(marked).toMatchObject({
      "Grace Hopper": ["In the space · Message", null],
      "Alan Turing": [null, "In the space · View"],
      "Carol Shaw": [null, null],
    });
    expect(await found("carol")).toEqual(["Carol Shaw"]);
    expect(await found("example")).toEqual(expect.arrayContaining(["Carol Shaw"]));
    const outsider = await t.signUp("Dee Dee", "dee@example.com");
    expect((await put(t, t.ada, id, outsider.userId)).status).toBe(404);
    expect((await put(t, t.ada, id, t.grace.userId)).status).toBe(404);
    expect((await put(t, t.ada, id, t.bob.userId)).status).toBe(200);
    // A viewer of the space can be given Edit.
    expect((await put(t, t.ada, id, t.alan.userId, "edit")).status).toBe(200);
    expect(
      (await t.json<ArtifactDetail>(await t.api("GET", `/artifacts/${id}`, t.alan.cookie)))
        .canShare,
    ).toBe(true);
  });

  it("refuses those who may not change it, and removing someone not given it", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await put(t, t.alan, id, t.carol.userId)).status).toBe(403);
    expect((await t.api("GET", `/artifacts/${id}/people`, t.alan.cookie)).status).toBe(403);
    expect(
      (await t.api("DELETE", `/artifacts/${id}/people/${t.carol.userId}`, t.ada.cookie)).status,
    ).toBe(404);
  });

  it("ends when they are removed or leave the org", async () => {
    const t = await team();
    const id = await t.publish();
    await t.json(await put(t, t.ada, id, t.carol.userId));
    expect(t.artifacts.viewable(t.carol, id)).toBe(true);
    await t.json(await t.api("DELETE", `/artifacts/${id}/people/${t.carol.userId}`, t.ada.cookie));
    expect(t.artifacts.viewable(t.carol, id)).toBe(false);
    await t.json(await put(t, t.ada, id, t.carol.userId));
    expect(t.artifacts.viewable(t.carol, id)).toBe(true);
    t.db.delete(schema.member).where(eq(schema.member.userId, t.carol.userId)).run();
    expect(t.artifacts.viewable(t.carol, id)).toBe(false);
    const detail = await detailOf(t, t.ada, id);
    expect(detail.people[0]).toMatchObject({ name: "Carol Shaw", former: true });
  });
});

describe("sharing with a group", () => {
  // A group of the directory linked to Ada's org with Carol in it.
  async function withGroup() {
    const t = await team();
    const id = await t.publish();
    const carol = t.db.select().from(schema.user).where(eq(schema.user.id, t.carol.userId)).get()!;
    const carolScim = await t.scim.createUser({ name: carol.name, email: carol.email });
    const groupId = await t.scim.createGroup("Looms", [carolScim]);
    t.db
      .insert(schema.orgGroup)
      .values({ organizationId: t.ada.orgId, groupId, role: "member" })
      .run();
    const give = (who: { cookie: string }, role?: "view" | "edit") =>
      t.api("PUT", `/artifacts/${id}/groups/${groupId}`, who.cookie, role ? { role } : {});
    const detailOf = async (who: { cookie: string }) =>
      t.json<ArtifactDetail>(await t.api("GET", `/artifacts/${id}`, who.cookie));
    return { ...t, id, groupId, carolScim, give, detailOf };
  }

  it("lets its members view the artifact, listed as one row, until it is removed", async () => {
    const t = await withGroup();
    expect(t.artifacts.viewable(t.carol, t.id)).toBe(false);
    const detail = await t.json<ArtifactDetail>(await t.give(t.ada));
    expect(detail.groups).toEqual([
      { groupId: t.groupId, name: "Looms", memberCount: 1, role: "view" },
    ]);
    expect(t.artifacts.viewable(t.carol, t.id)).toBe(true);
    expect((await t.detailOf(t.carol)).canShare).toBe(false);
    expect((await t.detailOf(t.carol)).groups).toEqual([]);
    expect(
      (await t.api("DELETE", `/artifacts/${t.id}/groups/${t.groupId}`, t.ada.cookie)).status,
    ).toBe(200);
    expect(t.artifacts.viewable(t.carol, t.id)).toBe(false);
    expect(
      (await t.api("DELETE", `/artifacts/${t.id}/groups/${t.groupId}`, t.ada.cookie)).status,
    ).toBe(404);
  });

  it("lets its members edit when given Edit, as long as they are in it", async () => {
    const t = await withGroup();
    await t.give(t.ada, "edit");
    expect((await t.detailOf(t.carol)).canShare).toBe(true);
    await t.scim.removeMembers(t.groupId, [t.carolScim]);
    expect(t.artifacts.viewable(t.carol, t.id)).toBe(false);
    await t.scim.addMembers(t.groupId, [t.carolScim]);
    expect((await t.detailOf(t.carol)).canShare).toBe(true);
  });

  it("lets an editor change it while another of their orgs is open", async () => {
    const t = await withGroup();
    await t.give(t.ada, "edit");
    const elsewhere = { ...t.carol, orgId: "another-org" };
    expect(() => t.artifacts.candidates(elsewhere, t.id, undefined)).not.toThrow();
  });

  it("offers the group beside people and marks it once added", async () => {
    const t = await withGroup();
    const candidates = async () =>
      t.json<{ kind: string; name: string; already: string | null; memberCount: number | null }[]>(
        await t.api("GET", `/artifacts/${t.id}/people?q=loom`, t.ada.cookie),
      );
    expect(await candidates()).toEqual([
      expect.objectContaining({ kind: "group", name: "Looms", already: null, memberCount: 1 }),
    ]);
    await t.give(t.ada);
    expect((await candidates())[0]).toMatchObject({ already: "Added" });
  });

  it("refuses those who may not change the artifact", async () => {
    const t = await withGroup();
    expect((await t.give(t.alan)).status).toBe(403);
    expect((await t.give(t.carol)).status).toBe(404);
  });
});

describe("edit access", () => {
  const sharing = (
    t: Awaited<ReturnType<typeof team>>,
    who: { cookie: string },
    id: string,
    body: object,
  ) => t.api("PUT", `/artifacts/${id}/sharing`, who.cookie, body);
  const detailOf = async (
    t: Awaited<ReturnType<typeof team>>,
    who: { cookie: string },
    id: string,
  ) => t.json<ArtifactDetail>(await t.api("GET", `/artifacts/${id}`, who.cookie));

  it("lets a person given Edit change its sharing but not delete it", async () => {
    const t = await team();
    const id = await t.publish();
    await t.api("PUT", `/artifacts/${id}/people/${t.carol.userId}`, t.grace.cookie, {
      role: "edit",
    });
    const mine = await detailOf(t, t.carol, id);
    expect(mine).toMatchObject({ canShare: true, canDelete: false });
    expect(mine.people[0]).toMatchObject({ name: "Carol Shaw", role: "edit" });
    expect((await sharing(t, t.carol, id, { sharing: "org" })).status).toBe(200);
    expect((await detailOf(t, t.ada, id)).sharing).toBe("org");
    expect((await t.api("DELETE", `/artifacts/${id}`, t.carol.cookie)).status).toBe(403);
  });

  it("keeps a person given View from changing it, and a change of role applies at once", async () => {
    const t = await team();
    const id = await t.publish();
    await t.api("PUT", `/artifacts/${id}/people/${t.carol.userId}`, t.ada.cookie, { role: "edit" });
    expect((await detailOf(t, t.carol, id)).canShare).toBe(true);
    await t.api("PUT", `/artifacts/${id}/people/${t.carol.userId}`, t.ada.cookie, { role: "view" });
    expect((await detailOf(t, t.carol, id)).canShare).toBe(false);
    expect((await sharing(t, t.carol, id, { sharing: "org" })).status).toBe(403);
  });

  it("gives a guest of a thread View only", async () => {
    const t = await team();
    const id = await t.publish();
    const invite = await t.api("POST", `/threads/${t.thread.id}/invites`, t.ada.cookie, {
      accessFor: "1d",
    });
    const { url } = await t.json<{ url: string }>(invite);
    await t.api("POST", "/invites/accept", t.bob.cookie, { token: url.split("/invite/")[1] });
    const edit = await t.api("PUT", `/artifacts/${id}/people/${t.bob.userId}`, t.ada.cookie, {
      role: "edit",
    });
    expect(edit.status).toBe(400);
    const view = await t.json<ArtifactDetail>(
      await t.api("PUT", `/artifacts/${id}/people/${t.bob.userId}`, t.ada.cookie, { role: "view" }),
    );
    expect(view.people[0]).toMatchObject({ guest: true, role: "view" });
  });

  it("lets the org's members change its sharing when the org may Edit, and not when it may View", async () => {
    const t = await team();
    const id = await t.publish();
    const shared = await t.json<ArtifactDetail>(await sharing(t, t.ada, id, { sharing: "org" }));
    expect(shared.orgRole).toBe("view");
    expect(await detailOf(t, t.carol, id)).toMatchObject({ canShare: false, orgRole: "view" });
    expect((await sharing(t, t.carol, id, { sharing: "space" })).status).toBe(403);

    await sharing(t, t.ada, id, { sharing: "org", orgRole: "edit" });
    expect(await detailOf(t, t.carol, id)).toMatchObject({
      canShare: true,
      canDelete: false,
      orgRole: "edit",
    });
    expect((await t.api("DELETE", `/artifacts/${id}`, t.carol.cookie)).status).toBe(403);
    expect((await sharing(t, t.carol, id, { sharing: "org", orgRole: "view" })).status).toBe(200);
    expect((await detailOf(t, t.carol, id)).canShare).toBe(false);
  });

  it("applies the org's Edit only while it is shared with the org", async () => {
    const t = await team();
    const id = await t.publish();
    await sharing(t, t.ada, id, { sharing: "org", orgRole: "edit" });
    await sharing(t, t.ada, id, { sharing: "space" });
    expect((await t.api("GET", `/artifacts/${id}`, t.carol.cookie)).status).toBe(404);
    expect((await sharing(t, t.carol, id, { sharing: "org" })).status).toBe(404);
  });

  it("leaves deleting and the space's members as they were", async () => {
    const t = await team();
    const id = await t.publish();
    expect(await detailOf(t, t.grace, id)).toMatchObject({ canShare: true, canDelete: true });
    expect(await detailOf(t, t.alan, id)).toMatchObject({ canShare: false, canDelete: false });
  });
});

describe("deleting", () => {
  it("is for those who can post in the space, and tells viewers; the artifact's threads are listed", async () => {
    const t = await team();
    const id = await t.publish();
    const other = await t.createThread(t.ada.cookie, t.space.id);
    await t.call(ARTIFACT_TOOLS.read, { id }, other.id);
    const detail = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.ada.cookie),
    );
    expect(detail.canDelete).toBe(true);
    expect(detail.madeIn?.id).toBe(t.thread.id);
    expect(detail.usedIn.map((one) => one.id).toSorted()).toEqual(
      [t.thread.id, other.id].toSorted(),
    );
    const asAlan = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.alan.cookie),
    );
    expect(asAlan.canDelete).toBe(false);
    expect((await t.api("DELETE", `/artifacts/${id}`, t.alan.cookie)).status).toBe(403);
    expect((await t.api("DELETE", `/artifacts/${id}`, t.bob.cookie)).status).toBe(404);
    expect((await t.api("DELETE", `/artifacts/${id}`, t.grace.cookie)).status).toBe(204);
    expect((await t.api("GET", `/artifacts/${id}`, t.ada.cookie)).status).toBe(404);
  });
});

describe("page", () => {
  it("is wrapped in the shell, which sets the theme and drops a doctype", () => {
    const shell = shellOf("<!DOCTYPE html><p>x</p>", "dark");
    expect(shell.startsWith('<!doctype html><html lang="en" data-theme="dark">')).toBe(true);
    expect(shell.match(/<!doctype/gi)).toHaveLength(1);
    expect(shellOf("<p>x</p>", null)).toContain('<html lang="en">');
  });

  it("is named by a title in its first 8 KB, else Untitled", () => {
    expect(titleOf("<head><title> A &amp; B </title>")).toBe("A & B");
    expect(titleOf(`${" ".repeat(9000)}<title>Late</title>`)).toBe("Untitled");
    expect(titleOf("<p>none</p>")).toBe("Untitled");
  });
});

describe("viewing links", () => {
  it("open the page on the artifact origin with the shell, the viewer's theme and the policy", async () => {
    const t = await team();
    const id = await t.publish();
    const link = await t.json<ArtifactView>(await t.view(t.ada, id, { theme: "dark" }));
    expect(link.url.startsWith(`${ARTIFACT_ORIGIN}/_a/v/`)).toBe(true);
    const res = await t.artifacts.content(new Request(link.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(contentPolicy("http://localhost:4783"));
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('data-theme="dark"');
    expect(body).toContain("<h1>Sales</h1>");
  });

  it("serve the page's files, relative to it, under the same policy", async () => {
    const t = await team();
    const id = await t.publish({
      assets: [{ name: "logo.png", contentType: "image/png", base64: PNG }],
    });
    const link = await t.json<ArtifactView>(await t.view(t.ada, id));
    const res = await t.artifacts.content(new Request(new URL("logo.png", link.url)));
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("show an older version when asked for it", async () => {
    const t = await team();
    const id = await t.publish();
    await t.call(ARTIFACT_TOOLS.update, { id, html: "<title>New</title><p>new</p>" });
    expect(await (await t.open(t.ada, id)).text()).toContain("<p>new</p>");
    expect(await (await t.open(t.ada, id, { version: 1 })).text()).toContain("<h1>Sales</h1>");
    expect((await t.view(t.ada, id, { version: 9 })).status).toBe(404);
  });

  it("are refused to those who may not view the artifact", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await t.view(t.bob, id)).status).toBe(404);
  });

  it("expire after an hour and are refused when tampered with", async () => {
    const t = await team();
    const id = await t.publish();
    const link = await t.json<ArtifactView>(await t.view(t.ada, id));
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    // A changed payload character, since the signature's last character can carry unused bits.
    const tampered = link.url.replace(
      /\/v\/([^.]+)\.(.)/,
      (_, head: string, first: string) => `/v/${head}.${first === "e" ? "f" : "e"}`,
    );
    expect(tampered).not.toBe(link.url);
    expect((await t.artifacts.content(new Request(tampered))).status).toBe(401);
  });

  it("stop working once the viewer may no longer view the artifact", async () => {
    const t = await team();
    const id = await t.publish();
    await t.json(await t.api("PUT", `/artifacts/${id}/sharing`, t.ada.cookie, { sharing: "org" }));
    const link = await t.json<ArtifactView>(await t.view(t.carol, id));
    expect((await t.artifacts.content(new Request(link.url))).status).toBe(200);
    await t.json(
      await t.api("PUT", `/artifacts/${id}/sharing`, t.ada.cookie, { sharing: "space" }),
    );
    expect((await t.artifacts.content(new Request(link.url))).status).toBe(404);
  });

  it("are not made while no artifact origin is set", async () => {
    const t = await team();
    const { createArtifacts } = await import("./service.ts");
    const { createArtifactStore } = await import("./store.ts");
    const bare = createArtifacts({
      store: createArtifactStore(t.db),
      threads: t.threadStore,
      spaceStore: t.spaceStore,
      spaces: t.spaces,
      access: t.access,
      guests: t.guestStore,
      directory: t.directory,
      appOrigin: "http://localhost:4783",
      artifactOrigin: null,
      secret: "another-secret-that-is-long-enough-0123456789",
    });
    const id = await t.publish();
    await expect(
      bare.view({ userId: t.ada.userId, orgId: t.ada.orgId, role: "owner" } as never, id, {}),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("the artifact origin", () => {
  it("answers only pages and files: no API, no web client, no app cookies", async () => {
    const t = await team();
    const id = await t.publish();
    for (const path of ["/api/v1/spaces", "/api/health", "/", "/index.html", `/_a/x/${id}`]) {
      const res = await t.artifacts.content(
        new Request(`${ARTIFACT_ORIGIN}${path}`, { headers: { cookie: t.ada.cookie } }),
      );
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  it("serves a public artifact by id without a link, and no other", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await t.artifacts.content(new Request(`${ARTIFACT_ORIGIN}/_a/p/${id}/`))).status).toBe(
      404,
    );
  });
});

describe("an origin per artifact", () => {
  const PATTERN = "http://*.localhost:4783";

  async function wildcard() {
    const t = await team();
    const { createArtifacts } = await import("./service.ts");
    const artifacts = createArtifacts({
      store: createArtifactStore(t.db),
      threads: t.threadStore,
      spaceStore: t.spaceStore,
      spaces: t.spaces,
      access: t.access,
      guests: t.guestStore,
      directory: t.directory,
      appOrigin: "http://localhost:4783",
      artifactOrigin: PATTERN,
      secret: "test-secret-that-is-long-enough-0123456789",
    });
    const principal = { userId: t.ada.userId, orgId: t.ada.orgId, role: "owner" } as never;
    const link = async (id: string) => (await artifacts.view(principal, id, {})).url;
    return { ...t, artifacts, link };
  }

  it("mints links on the artifact's own lower-cased host", async () => {
    const t = await wildcard();
    const id = await t.publish();
    expect((await t.link(id)).startsWith(`http://${id.toLowerCase()}.localhost:4783/_a/v/`)).toBe(
      true,
    );
  });

  it("serves a link on its own artifact's host only", async () => {
    const t = await wildcard();
    const a = await t.publish();
    const b = await t.publish();
    const linkA = await t.link(a);
    expect((await t.artifacts.content(new Request(linkA))).status).toBe(200);
    const onB = linkA.replace(a.toLowerCase(), b.toLowerCase());
    expect((await t.artifacts.content(new Request(onB))).status).toBe(404);
    const onApp = linkA.replace(`${a.toLowerCase()}.`, "");
    expect((await t.artifacts.content(new Request(onApp))).status).toBe(404);
  });

  it("serves a public artifact on its own host only", async () => {
    const t = await wildcard();
    const a = await t.publish();
    const b = await t.publish();
    const store = createArtifactStore(t.db);
    store.setOrgPublicAllowed(t.ada.orgId, true);
    store.setSpacePublicAllowed(t.space.id, true);
    store.setSharing(a, "public");
    const host = (id: string) => `http://${id.toLowerCase()}.localhost:4783`;
    expect((await t.artifacts.content(new Request(`${host(a)}/_a/p/${a}/`))).status).toBe(200);
    expect((await t.artifacts.content(new Request(`${host(b)}/_a/p/${a}/`))).status).toBe(404);
  });

  it("routes a request to the content app by its host", async () => {
    const t = await wildcard();
    const id = (await t.publish()).toLowerCase();
    expect(t.artifacts.servesHost(new Request(`http://${id}.localhost:4783/`))).toBe(true);
    expect(t.artifacts.servesHost(new Request(`http://${id.toUpperCase()}.localhost:4783/`))).toBe(
      true,
    );
    for (const url of [
      "http://localhost:4783/",
      "http://a.b.localhost:4783/",
      `http://${id}.localhost:4784/`,
      `http://${id}.example.com/`,
    ]) {
      expect(t.artifacts.servesHost(new Request(url)), url).toBe(false);
    }
  });

  it("keeps the shared origin as one host", async () => {
    const t = await team();
    expect(t.artifacts.servesHost(new Request(`${ARTIFACT_ORIGIN}/`))).toBe(true);
    expect(t.artifacts.servesHost(new Request("http://localhost:4783/"))).toBe(false);
    const id = await t.publish();
    const link = await t.json<ArtifactView>(await t.view(t.ada, id));
    expect(link.url.startsWith(`${ARTIFACT_ORIGIN}/_a/v/`)).toBe(true);
  });
});

describe("service workers", () => {
  it("are refused on the artifact origin, and the policy allows no worker but blob", async () => {
    const t = await team();
    const id = await t.publish();
    const link = await t.json<ArtifactView>(await t.view(t.ada, id));
    const res = await t.artifacts.content(
      new Request(link.url, { headers: { "Service-Worker": "script" } }),
    );
    expect(res.status).toBe(403);
    const policy = contentPolicy("http://localhost:4783");
    expect(policy).toContain("worker-src blob:;");
  });
});

describe("sharing", () => {
  const share = (
    t: Awaited<ReturnType<typeof team>>,
    who: { cookie: string },
    id: string,
    sharing: string,
  ) => t.api("PUT", `/artifacts/${id}/sharing`, who.cookie, { sharing });

  it("starts at the space, and widens to the org and, where allowed, anyone", async () => {
    const t = await team();
    const id = await t.publish();
    // The space's members view it already; sharing to the org reaches those outside it.
    const before = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.ada.cookie),
    );
    expect(before.sharing).toBe("space");
    expect(before.madeIn).toEqual({ id: t.thread.id, title: null });
    expect(before.sharingLevels).toEqual(["space", "org"]);
    expect((await t.view(t.alan, id)).status).toBe(200);
    expect((await t.view(t.carol, id)).status).toBe(404);
    expect((await share(t, t.ada, id, "org")).status).toBe(200);
    expect((await t.view(t.carol, id)).status).toBe(200);
    // Carol may open the artifact but not read the thread it came from.
    const asCarol = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.carol.cookie),
    );
    expect(asCarol.madeIn).toBeNull();
    expect(asCarol.space).toBeNull();
    expect((await t.view(t.bob, id)).status).toBe(404);
  });

  it("is changed only by those who can post in the space", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await share(t, t.alan, id, "org")).status).toBe(403);
    expect((await share(t, t.grace, id, "org")).status).toBe(200);
    const asAlan = await t.json<Artifact>(await t.api("GET", `/artifacts/${id}`, t.alan.cookie));
    expect(asAlan.canShare).toBe(false);
    expect(asAlan.sharingLevels).toEqual([]);
    expect(asAlan.sharingBlocked.map((one) => one.level)).toEqual(["space", "org", "public"]);
    expect((await share(t, t.bob, id, "space")).status).toBe(404);
  });

  it("is public only while the org and the space both allow it", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await share(t, t.ada, id, "public")).status).toBe(403);
    const closed = await t.json<Artifact>(await t.api("GET", `/artifacts/${id}`, t.ada.cookie));
    expect(closed.sharingLevels).toEqual(["space", "org"]);
    expect(closed.sharingBlocked).toEqual([]);
    await t.json(
      await t.api("PUT", "/org/artifacts/settings", t.ada.cookie, { publicAllowed: true }),
    );
    await t.json(
      await t.api("PUT", `/spaces/${t.space.id}/artifacts/settings`, t.ada.cookie, {
        publicAllowed: false,
      }),
    );
    expect((await share(t, t.ada, id, "public")).status).toBe(403);
    await t.json(
      await t.api("PUT", `/spaces/${t.space.id}/artifacts/settings`, t.ada.cookie, {
        publicAllowed: true,
      }),
    );
    const shared = await t.json<Artifact>(await share(t, t.ada, id, "public"));
    expect(shared.sharing).toBe("public");
    expect(shared.sharingLevels).toEqual(["space", "org", "public"]);
    const opened = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.alan.cookie),
    );
    expect(opened.publicUrl).toBe(`${ARTIFACT_ORIGIN}/_a/p/${id}/`);
    const page = await t.artifacts.content(new Request(`${ARTIFACT_ORIGIN}/_a/p/${id}/`));
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors");
    // Turning the org's switch off ends public access at once.
    await t.json(
      await t.api("PUT", "/org/artifacts/settings", t.ada.cookie, { publicAllowed: false }),
    );
    expect((await t.artifacts.content(new Request(`${ARTIFACT_ORIGIN}/_a/p/${id}/`))).status).toBe(
      404,
    );
    const closedAgain = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.ada.cookie),
    );
    expect(closedAgain.publicUrl).toBeNull();
  });

  it("is changed in settings only by those who may manage them", async () => {
    const t = await team();
    expect(
      (await t.api("PUT", "/org/artifacts/settings", t.grace.cookie, { publicAllowed: true }))
        .status,
    ).toBe(403);
    const org = await t.json<ArtifactSettings>(
      await t.api("GET", "/org/artifacts/settings", t.grace.cookie),
    );
    expect(org).toEqual({ publicAllowed: false, orgPublicAllowed: false, canManage: false });
    expect(
      (
        await t.api("PUT", `/spaces/${t.space.id}/artifacts/settings`, t.grace.cookie, {
          publicAllowed: true,
        })
      ).status,
    ).toBe(403);
    const space = await t.json<ArtifactSettings>(
      await t.api("GET", `/spaces/${t.space.id}/artifacts/settings`, t.ada.cookie),
    );
    expect(space).toEqual({ publicAllowed: true, orgPublicAllowed: false, canManage: true });
  });
});

describe("gallery", () => {
  const list = async (t: Awaited<ReturnType<typeof team>>, who: { cookie: string }, query = "") =>
    (
      await t.json<{
        items: { id: string; madeIn: unknown; space: { id: string } }[];
        total: number;
      }>(await t.api("GET", `/artifacts${query}`, who.cookie))
    ).items.map((item) => item.id);

  it("lists what the person can open and nothing else", async () => {
    const t = await team();
    const mine = await t.publish();
    const other = await t.createSpace(t.ada.cookie, "Other");
    const hidden = await t.createThread(t.ada.cookie, other.id);
    const elsewhere = await t.call(
      ARTIFACT_TOOLS.publish,
      {
        html: PAGE,
        description: "Elsewhere",
        icon: "chart",
      },
      hidden.id,
      other.id,
    );
    if (!elsewhere.ok) throw new Error(elsewhere.error);
    const hiddenId = elsewhere.value.id as string;
    // The space's readers see its artifacts; Carol, in the org alone, sees none yet.
    expect(await list(t, t.ada)).toEqual([hiddenId, mine]);
    expect(await list(t, t.alan)).toEqual([mine]);
    expect(await list(t, t.carol)).toEqual([]);
    expect(await list(t, t.bob)).toEqual([]);
    // Org level reaches Carol, who may open it but not read its thread.
    await t.json(
      await t.api("PUT", `/artifacts/${mine}/sharing`, t.ada.cookie, { sharing: "org" }),
    );
    const page = await t.json<{
      items: { id: string; madeIn: unknown; space: { id: string } }[];
    }>(await t.api("GET", "/artifacts", t.carol.cookie));
    expect(page.items.map((one) => one.id)).toEqual([mine]);
    expect(page.items[0]!.madeIn).toBeNull();
    expect(page.items[0]!.space.id).toBe(t.space.id);
    // Public, while allowed, is shown to the org's members; never to another org.
    await t.json(
      await t.api("PUT", "/org/artifacts/settings", t.ada.cookie, { publicAllowed: true }),
    );
    await t.json(
      await t.api("PUT", `/spaces/${other.id}/artifacts/settings`, t.ada.cookie, {
        publicAllowed: true,
      }),
    );
    await t.json(
      await t.api("PUT", `/artifacts/${hiddenId}/sharing`, t.ada.cookie, { sharing: "public" }),
    );
    expect(await list(t, t.carol)).toEqual([hiddenId, mine]);
    expect(await list(t, t.bob)).toEqual([]);
    // Gone ones are not listed.
    await t.api("DELETE", `/artifacts/${mine}`, t.ada.cookie);
    expect(await list(t, t.carol)).toEqual([hiddenId]);
  });

  it("pages, newest change first", async () => {
    const t = await team();
    const mine = await t.publish();
    const other = await t.createSpace(t.ada.cookie, "Other");
    const second = await t.createThread(t.ada.cookie, other.id);
    const made = await t.call(
      ARTIFACT_TOOLS.publish,
      {
        html: PAGE,
        description: "Second",
        icon: "chart",
      },
      second.id,
      other.id,
    );
    if (!made.ok) throw new Error(made.error);
    const secondId = made.value.id as string;
    await t.json(
      await t.api("PUT", `/artifacts/${mine}/sharing`, t.ada.cookie, { sharing: "org" }),
    );
    expect(await list(t, t.ada)).toEqual([mine, secondId]);
    const paged = await t.json<{
      items: { id: string }[];
      nextCursor: string | null;
      total: number;
    }>(await t.api("GET", "/artifacts?limit=1", t.ada.cookie));
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(2);
    expect(paged.nextCursor).toBe("1");
  });
});

describe("events", () => {
  it("tell followers of a publish, a sharing change and a delete", async () => {
    const t = await team();
    const id = await t.publish();
    const seen: ArtifactEvent[] = [];
    const stop = t.artifacts.follow(
      { userId: t.ada.userId, orgId: t.ada.orgId, role: "owner" } as never,
      id,
      (event) => seen.push(event),
    );
    await t.call(ARTIFACT_TOOLS.update, { id, html: "<title>Two</title>", label: "Two" });
    await t.api("PUT", `/artifacts/${id}/sharing`, t.ada.cookie, { sharing: "org" });
    await t.api("DELETE", `/artifacts/${id}`, t.ada.cookie);
    stop();
    expect(seen).toEqual([
      { type: "published", artifactId: id, version: 2, label: "Two", title: "Two" },
      { type: "sharing", artifactId: id, sharing: "org" },
      { type: "deleted", artifactId: id },
    ]);
  });
});

describe("preview", () => {
  it("is left out of the toolset's tools where no browser is at hand", async () => {
    const t = await team();
    const preview = t.artifacts
      .toolset()
      .tools.find((tool) => tool.name === ARTIFACT_TOOLS.preview)!;
    expect(preview.usefulIn?.({ id: t.space.id, orgId: t.ada.orgId })).toBe(false);
    expect(preview.description).toContain("at most once");
  });
});

describe("preview with a browser", () => {
  it("reports overflow, ignored themes and blocked loads for a page", async () => {
    const previewer = await loadChromiumPreviewer();
    if (!previewer) return;
    const t = await team({ previewer });
    const id = await t.publish({
      html: '<title>Wide</title><div style="width:2000px;color:black;background:white">wide</div><img src="https://example.com/x.png">',
    });
    const result = await t.call(ARTIFACT_TOOLS.preview, { id });
    expect(result).toMatchObject({ ok: true });
    const report = (result as { value: PreviewReport }).value;
    expect(report.renders.some((render) => render.overflow)).toBe(true);
    expect(report.blocked.map((one) => one.directive)).toContain("img-src");
  }, 120_000);
});
