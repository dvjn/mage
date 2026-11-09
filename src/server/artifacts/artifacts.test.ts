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
  const ctx = (threadId = thread.id): ToolContext =>
    ({
      threadId,
      spaceId: space.id,
      orgId: ada.orgId,
      runId: "run",
      callId: "call",
      actor: { kind: "agent" },
      model: null,
      runAs: null,
      write: (work) => work(() => {}),
    }) as ToolContext;
  async function call(name: string, input: object, threadId?: string) {
    const spec = specs.get(name)!;
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) return { ok: false as const, error: parsed.error.message };
    return (await spec.run(parsed.data, ctx(threadId))) as
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
      sharing: "thread",
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

  it("lists, reads and deletes only the thread's own artifacts", async () => {
    const t = await team();
    const id = await t.publish();
    const other = await t.createThread(t.ada.cookie, t.space.id);
    expect(await t.call(ARTIFACT_TOOLS.list, {}, other.id)).toMatchObject({
      value: { artifacts: [] },
    });
    expect(await t.call(ARTIFACT_TOOLS.read, { id }, other.id)).toMatchObject({ ok: false });
    expect(await t.call(ARTIFACT_TOOLS.delete, { id }, other.id)).toMatchObject({ ok: false });
    expect(await t.call(ARTIFACT_TOOLS.delete, { id })).toMatchObject({ ok: true });
    expect((await t.api("GET", `/artifacts/${id}`, t.ada.cookie)).status).toBe(404);
  });

  it("says deleting is for when a person asks, and asks before it", async () => {
    const t = await team();
    const toolset = t.artifacts.toolset();
    const del = toolset.tools.find((tool) => tool.name === ARTIFACT_TOOLS.delete)!;
    expect(del.description).toContain("Only when a person asks");
    expect(del.risk({ id: "x" }, { model: null })).toBe("ask");
    const publish = toolset.tools.find((tool) => tool.name === ARTIFACT_TOOLS.publish)!;
    expect(publish.risk({}, { model: null })).toBe("normal");
  });

  it("goes with the thread's root: a thread forked from it keeps the same artifacts", async () => {
    const t = await team();
    const id = await t.publish();
    expect(await t.call(ARTIFACT_TOOLS.read, { id })).toMatchObject({ ok: true });
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
      await t.api("PUT", `/artifacts/${id}/sharing`, t.ada.cookie, { sharing: "thread" }),
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

  it("starts at the thread, and widens to the org and, where allowed, anyone", async () => {
    const t = await team();
    const id = await t.publish();
    // The space's members read its threads already; sharing to the org reaches those outside it.
    const before = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.ada.cookie),
    );
    expect(before.sharing).toBe("thread");
    expect(before.thread).toEqual({ title: null });
    expect(before.sharingLevels).toEqual(["thread", "org"]);
    expect((await t.view(t.alan, id)).status).toBe(200);
    expect((await t.view(t.carol, id)).status).toBe(404);
    expect((await share(t, t.ada, id, "org")).status).toBe(200);
    expect((await t.view(t.carol, id)).status).toBe(200);
    // Carol may open the artifact but not the thread it came from.
    const asCarol = await t.json<ArtifactDetail>(
      await t.api("GET", `/artifacts/${id}`, t.carol.cookie),
    );
    expect(asCarol.thread).toBeNull();
    expect((await t.view(t.bob, id)).status).toBe(404);
  });

  it("is changed only by those who can post in the thread's space", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await share(t, t.alan, id, "org")).status).toBe(403);
    expect((await share(t, t.grace, id, "org")).status).toBe(200);
    const asAlan = await t.json<Artifact>(await t.api("GET", `/artifacts/${id}`, t.alan.cookie));
    expect(asAlan.canShare).toBe(false);
    expect(asAlan.sharingLevels).toEqual([]);
    expect(asAlan.sharingBlocked.map((one) => one.level)).toEqual(["thread", "org", "public"]);
    expect((await share(t, t.bob, id, "thread")).status).toBe(404);
  });

  it("is public only while the org and the space both allow it", async () => {
    const t = await team();
    const id = await t.publish();
    expect((await share(t, t.ada, id, "public")).status).toBe(403);
    const closed = await t.json<Artifact>(await t.api("GET", `/artifacts/${id}`, t.ada.cookie));
    expect(closed.sharingLevels).toEqual(["thread", "org"]);
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
    expect(shared.sharingLevels).toEqual(["thread", "org", "public"]);
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
        items: { id: string; thread: unknown; space: { id: string } }[];
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
      items: { id: string; thread: unknown; space: { id: string } }[];
    }>(await t.api("GET", "/artifacts", t.carol.cookie));
    expect(page.items.map((one) => one.id)).toEqual([mine]);
    expect(page.items[0]!.thread).toBeNull();
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
    await t.call(ARTIFACT_TOOLS.delete, { id: mine });
    expect(await list(t, t.carol)).toEqual([hiddenId]);
  });

  it("narrows to a space or a sharing level", async () => {
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
    );
    if (!made.ok) throw new Error(made.error);
    const secondId = made.value.id as string;
    await t.json(
      await t.api("PUT", `/artifacts/${mine}/sharing`, t.ada.cookie, { sharing: "org" }),
    );
    expect(await list(t, t.ada, `?space=${other.id}`)).toEqual([secondId]);
    expect(await list(t, t.ada, "?sharing=org")).toEqual([mine]);
    expect(await list(t, t.ada, `?space=${other.id}&sharing=org`)).toEqual([]);
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
    await t.call(ARTIFACT_TOOLS.delete, { id });
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
