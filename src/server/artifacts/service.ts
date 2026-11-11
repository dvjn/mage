// Artifacts: HTML pages the agent publishes in a space, each publish a version, with the files
// they load. They belong to the space, not to a thread: every thread there can read and update
// them, and they follow the space's retention and deletion. People view them on an origin of their
// own, apart from the app's, through links the app signs for one viewer and one artifact for a
// short while; the app's session never reaches that origin. The space's members may view its
// artifacts; sharing widens that to its org's members, or anyone with a link, which the org and
// the space must both allow. Only those who can post in the space change sharing or delete an
// artifact, and people never edit one: the agent publishes and updates them with its tools.

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { ulid } from "ulid";
import * as z from "zod";

import type { Toolset, ToolSpec, ToolContext } from "@/server/agent/tools.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Directory } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import { spaceNameFor } from "@/shared/spaces.ts";
import type { ThreadAccess } from "@/server/spaces/thread-access.ts";
import { type Page, PAGE_LIMIT } from "@/shared/paging.ts";
import type { ThreadStore } from "@/server/threads/service.ts";
import {
  ARTIFACT_TOOLS,
  ARTIFACT_TOOLSET,
  type Artifact,
  type ArtifactDetail,
  type ArtifactEvent,
  type ArtifactListItem,
  type ArtifactListQuery,
  type ArtifactSettings,
  type ArtifactSharing,
  type ArtifactTheme,
  type ArtifactView,
  type ArtifactViewRequest,
  artifactScopeSchema,
  artifactThemeSchema,
} from "@/shared/artifacts.ts";

import { ARTIFACT_GUIDANCE } from "./guidance.ts";
import { artifactOfHost, isArtifactHost, isOriginPattern, originOf } from "./origin.ts";
import {
  applyEdits,
  ASSET_MAX_BYTES,
  ASSET_NAME,
  ASSET_TYPES,
  ASSETS_MAX,
  ASSETS_MAX_BYTES,
  contentPolicy,
  type Edit,
  PAGE_MAX_BYTES,
  shellOf,
  titleOf,
} from "./page.ts";
import type { ArtifactPreviewer, PreviewReport } from "./preview.ts";

export interface ArtifactRecord {
  id: string;
  spaceId: string;
  createdInThreadId: string | null;
  sharing: ArtifactSharing;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VersionFields {
  label: string | null;
  title: string;
  description: string;
  icon: string;
}

export interface VersionRecord extends VersionFields {
  version: number;
  createdAt: Date;
  // The thread whose agent published it, while that thread is kept.
  threadId?: string | null;
  html?: string;
}

export interface NewAsset {
  name: string;
  contentType: string;
  data: Buffer;
}

type NewVersion = VersionFields & { html: string; runId: string | null; callId: string | null };

export interface ArtifactStore {
  create(artifact: {
    id: string;
    spaceId: string;
    threadId: string;
    version: NewVersion;
    assets: NewAsset[];
  }): void;
  find(id: string): ArtifactRecord | null;
  // The artifacts the thread used, oldest first.
  inThread(threadId: string): ArtifactRecord[];
  // The space's artifacts, last changed first.
  inSpace(spaceId: string): ArtifactRecord[];
  // Notes that the thread used the artifact.
  use(id: string, threadId: string): void;
  // The threads that used the artifact, earliest first.
  usedIn(id: string): string[];
  // Every artifact of the org's spaces, last changed first.
  inOrg(orgId: string): ArtifactRecord[];
  version(id: string, version: number): (VersionRecord & { html: string }) | null;
  // Newest first, without their pages.
  versions(id: string): VersionRecord[];
  // Adds the next version, when the newest is still `basedOn`; else says which is.
  addVersion(
    id: string,
    basedOn: number,
    change: { version: NewVersion; threadId: string; assets: NewAsset[]; removed: string[] },
  ): { version: number } | { stale: number } | null;
  assets(id: string): { name: string; contentType: string; size: number }[];
  asset(id: string, name: string): { contentType: string; data: Buffer } | null;
  setSharing(id: string, sharing: ArtifactSharing): void;
  delete(id: string): void;
  orgPublicAllowed(orgId: string): boolean;
  setOrgPublicAllowed(orgId: string, allowed: boolean): void;
  spacePublicAllowed(spaceId: string): boolean;
  setSpacePublicAllowed(spaceId: string, allowed: boolean): void;
}

export interface ArtifactsOptions {
  store: ArtifactStore;
  threads: Pick<ThreadStore, "find">;
  spaceStore: Pick<SpaceStore, "find">;
  spaces: Pick<Spaces, "findVisible" | "can" | "require" | "isGone">;
  access: Pick<ThreadAccess, "can" | "require">;
  directory: Pick<Directory, "roleIn" | "user">;
  // The app's origin, the only one that may frame a page.
  appOrigin: string;
  // Where pages are served from, with `*` as its leftmost label for an origin per artifact; null
  // while none is configured, when no links are made.
  artifactOrigin: string | null;
  // Signs viewing links.
  secret: string;
  // Renders pages for the agent to check; null where no browser is at hand.
  previewer?: ArtifactPreviewer | null;
  now?: () => Date;
}

export type Artifacts = ReturnType<typeof createArtifacts>;

// How long a viewing link lasts, and one made for a preview.
const VIEW_TTL_MS = 60 * 60 * 1000;
const PREVIEW_TTL_MS = 2 * 60 * 1000;
const AUDIENCE = "artifact-view";

// Where a preview's page is served from, which no network has.
const PREVIEW_ORIGIN = "https://*.preview.artifact.invalid";

// Paths on the artifacts' origin: a page by signed link, or a public one by id.
export const CONTENT_PREFIX = "/_a";

const LEVELS: readonly ArtifactSharing[] = ["space", "org", "public"];

// Who views: a person, or the agent previewing, or someone with a public link.
type Viewer = { userId: string; orgId: string } | { agent: true } | null;

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .meta({ title: "Label", description: "A few words naming this version" });
const descriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .meta({ title: "Description", description: "One sentence saying what the page is" });
const iconSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "One plain lower-case word")
  .meta({ title: "Icon", description: "One generic word, such as chart, calendar or map" });
const htmlSchema = z
  .string()
  .min(1)
  .max(PAGE_MAX_BYTES)
  .meta({ title: "HTML", description: "The page; the document shell is added" });
const assetSchema = z.object({
  name: z.string().regex(ASSET_NAME, "A plain file name such as chart.png"),
  contentType: z.enum(ASSET_TYPES),
  base64: z.string().min(1),
});
const assetsSchema = z
  .array(assetSchema)
  .max(ASSETS_MAX)
  .meta({ title: "Files", description: "Files the page loads by name, as base64" });
const editSchema = z.object({ old: z.string().min(1), new: z.string() });
const idSchema = z.string().min(1).meta({ title: "Artifact" });

type AssetInput = z.infer<typeof assetSchema>;

interface PublishInput {
  html: string;
  description: string;
  icon: string;
  label?: string;
  assets?: AssetInput[];
}

interface UpdateInput {
  id: string;
  basedOn?: number;
  html?: string;
  edits?: Edit[];
  label?: string;
  description?: string;
  icon?: string;
  assets?: AssetInput[];
  removeAssets?: string[];
}

export function createArtifacts(options: ArtifactsOptions) {
  const { store, threads, spaceStore, spaces, access, directory, appOrigin } = options;

  // The space as the person sees it named: their own personal space, another's named for its
  // person, or its own name.
  function shownSpace(principal: Principal, space: Space) {
    const owner = space.createdBy ? directory.user(space.createdBy)?.name : null;
    const own = space.createdBy === principal.userId;
    return { id: space.id, name: spaceNameFor(space, owner ?? "A former member", own) };
  }
  const now = options.now ?? (() => new Date());
  const previewer = options.previewer ?? null;
  const key = createHmac("sha256", options.secret).update(AUDIENCE).digest();
  const feed = new EventEmitter();
  feed.setMaxListeners(0);

  function publish(event: ArtifactEvent) {
    feed.emit(event.artifactId, event);
  }

  // The thread an agent's work is recorded on: the root of the one it runs in.
  function rootOf(threadId: string) {
    const thread = threads.find(threadId);
    if (!thread) throw new Error("the thread is gone");
    return thread.rootThreadId ? (threads.find(thread.rootThreadId) ?? thread) : thread;
  }

  function spaceOf(record: ArtifactRecord) {
    return spaceStore.find(record.spaceId);
  }

  // Whether the org and the space let the space's artifacts be made public.
  function publicAllowed(space: { id: string; orgId: string }) {
    return store.orgPublicAllowed(space.orgId) && store.spacePublicAllowed(space.id);
  }

  // Whether the viewer may view the artifact: the agent always; the space's members; and as far as
  // its sharing reaches, while its space is not gone, the org's members, or anyone, while the org
  // and the space allow it. A thread's guests see only what is shared beyond the space.
  function canView(viewer: Viewer, record: ArtifactRecord) {
    const space = spaceOf(record);
    if (!space) return false;
    if (viewer && "agent" in viewer) return true;
    if (viewer && spaces.can(viewer, space, "read")) return true;
    if (spaces.isGone(space.id)) return false;
    const level = LEVELS.indexOf(record.sharing);
    if (level >= 2 && publicAllowed(space)) return true;
    if (!viewer || viewer.orgId !== space.orgId) return false;
    return level >= 1 && !!directory.roleIn(space.orgId, viewer.userId);
  }

  // Whether the person may change the artifacts of the space: share and delete them.
  function mayChange(principal: Principal, space: Space) {
    return principal.orgId === space.orgId && spaces.can(principal, space, "message");
  }

  // The levels the person may share the artifact at, none when they may not change it.
  function levelsFor(principal: Principal, space: Space) {
    if (!mayChange(principal, space)) return [];
    return LEVELS.filter((level) => level !== "public" || publicAllowed(space));
  }

  // Why the person may not share at all, said for every level; a level only public is closed to
  // is left out of the levels instead.
  function blockedFor(
    principal: Principal,
    space: Space,
  ): { level: ArtifactSharing; reason: string }[] {
    if (levelsFor(principal, space).length > 0) return [];
    return LEVELS.map((level) => ({
      level,
      reason: "Only the space's messagers and owners can share artifacts",
    }));
  }

  function shown(record: ArtifactRecord, principal: Principal): Artifact {
    const space = spaceOf(record);
    const current = store.version(record.id, record.version);
    if (!space || !current) throw new ServiceError(404, "Artifact not found");
    const levels = levelsFor(principal, space);
    return {
      id: record.id,
      spaceId: space.id,
      title: current.title,
      description: current.description,
      icon: current.icon,
      version: record.version,
      label: current.label,
      sharing: record.sharing,
      assets: store.assets(record.id),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      canShare: levels.length > 0,
      canDelete: mayChange(principal, space),
      sharingLevels: levels,
      sharingBlocked: blockedFor(principal, space),
    };
  }

  // The artifact when the person may view it; one they may not is not found.
  function requireViewable(principal: Principal, id: string) {
    const record = store.find(id);
    if (!record || !canView(principal, record)) {
      throw new ServiceError(404, "Artifact not found");
    }
    return record;
  }

  async function sign(
    claims: { sub: string; uid?: string; org?: string; v?: number },
    ttl: number,
  ) {
    const expiresAt = new Date(now().getTime() + ttl);
    const token = await new SignJWT({
      ...(claims.uid && { uid: claims.uid, org: claims.org }),
      ...(claims.v && { v: claims.v }),
      ...(!claims.uid && { agent: true }),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now().getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(key);
    return { token, expiresAt };
  }

  // The artifact, version and viewer a link was signed for, while it holds.
  async function verify(token: string) {
    try {
      const { payload } = await jwtVerify(token, key, {
        audience: AUDIENCE,
        algorithms: ["HS256"],
        currentDate: now(),
      });
      if (typeof payload.sub !== "string") return null;
      const viewer: Viewer =
        payload.agent === true
          ? { agent: true }
          : typeof payload.uid === "string" && typeof payload.org === "string"
            ? { userId: payload.uid, orgId: payload.org }
            : null;
      if (!viewer) return null;
      return { id: payload.sub, version: typeof payload.v === "number" ? payload.v : null, viewer };
    } catch {
      return null;
    }
  }

  // Headers every response of the artifacts' origin carries. Links hold their token in the path,
  // so no request it makes says where it came from.
  function contentHeaders(contentType: string) {
    return {
      "Content-Type": contentType,
      "Content-Security-Policy": contentPolicy(appOrigin),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-cache",
    };
  }

  // Whether the request's host is the origin of this artifact: under an origin per artifact, a
  // link or id works on its own artifact's host alone.
  function onOwnHost(request: Request, id: string) {
    const host = new URL(request.url).host;
    const origin = options.artifactOrigin;
    const named =
      artifactOfHost(PREVIEW_ORIGIN, host) ??
      (origin !== null && isOriginPattern(origin)
        ? (artifactOfHost(origin, host) ?? "")
        : undefined);
    return named === undefined || named === id.toLowerCase();
  }

  function notFound() {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Referrer-Policy": "no-referrer" },
    });
  }

  // The page or one of its files, for a viewer who may view it.
  function content(
    request: Request,
    record: ArtifactRecord | null,
    viewer: Viewer,
    version: number | null,
    name: string | null,
    theme: ArtifactTheme | null,
  ) {
    if (!record || !canView(viewer, record) || !onOwnHost(request, record.id)) return notFound();
    if (name) {
      const asset = store.asset(record.id, name);
      if (!asset) return notFound();
      return new Response(new Uint8Array(asset.data), {
        headers: contentHeaders(asset.contentType),
      });
    }
    const page = store.version(record.id, version ?? record.version);
    if (!page) return notFound();
    return new Response(shellOf(page.html, theme), {
      headers: contentHeaders("text/html; charset=utf-8"),
    });
  }

  function themeOf(value: string | undefined) {
    const parsed = artifactThemeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  // What the artifacts' origin answers: pages and files by signed link, and public ones by id.
  async function signed(
    request: Request,
    token: string,
    name: string | null,
    theme: string | undefined,
  ) {
    const link = await verify(token);
    if (!link) {
      return new Response("This link has expired", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Referrer-Policy": "no-referrer" },
      });
    }
    return content(request, store.find(link.id), link.viewer, link.version, name, themeOf(theme));
  }

  function shared(request: Request, id: string, name: string | null, theme: string | undefined) {
    const record = store.find(id);
    return content(
      request,
      record?.sharing === "public" ? record : null,
      null,
      null,
      name,
      themeOf(theme),
    );
  }

  // A page's files load relative to it, so its address ends in a slash.
  const contentApp = new Hono()
    // Nothing on an artifact's origin may register a service worker, which would outlive the page.
    .use("*", async (c, next) => {
      if (c.req.header("Service-Worker") !== undefined) {
        return c.text("Forbidden", 403, { "Referrer-Policy": "no-referrer" });
      }
      await next();
    })
    .get(`${CONTENT_PREFIX}/:kind{v|p}/:key`, (c) => c.redirect(`${c.req.path}/`, 308))
    .get(`${CONTENT_PREFIX}/v/:token/`, (c) =>
      signed(c.req.raw, c.req.param("token"), null, c.req.query("theme")),
    )
    .get(`${CONTENT_PREFIX}/v/:token/:name`, (c) =>
      signed(c.req.raw, c.req.param("token"), c.req.param("name"), undefined),
    )
    .get(`${CONTENT_PREFIX}/p/:id/`, (c) =>
      shared(c.req.raw, c.req.param("id"), null, c.req.query("theme")),
    )
    .get(`${CONTENT_PREFIX}/p/:id/:name`, (c) =>
      shared(c.req.raw, c.req.param("id"), c.req.param("name"), undefined),
    )
    .all("*", () => notFound());

  // ---- The agent's tools ----

  function failed(error: string) {
    return Promise.resolve({ ok: false as const, error });
  }

  // The files as stored, or what is wrong with them, given those the artifact keeps.
  function assetsOf(
    inputs: readonly AssetInput[] = [],
    kept: readonly { name: string; size: number }[] = [],
  ): { ok: true; assets: NewAsset[] } | { ok: false; error: string } {
    const assets: NewAsset[] = [];
    const names = new Set<string>();
    for (const input of inputs) {
      if (names.has(input.name)) return { ok: false, error: `${input.name} is given twice.` };
      names.add(input.name);
      const data = Buffer.from(input.base64, "base64");
      if (data.length === 0) return { ok: false, error: `${input.name} is not base64.` };
      if (data.length > ASSET_MAX_BYTES) {
        return { ok: false, error: `${input.name} is over ${ASSET_MAX_BYTES / 1024 / 1024} MB.` };
      }
      assets.push({ name: input.name, contentType: input.contentType, data });
    }
    const others = kept.filter((asset) => !names.has(asset.name));
    if (others.length + assets.length > ASSETS_MAX) {
      return { ok: false, error: `An artifact keeps at most ${ASSETS_MAX} files.` };
    }
    const total =
      others.reduce((sum, asset) => sum + asset.size, 0) +
      assets.reduce((sum, asset) => sum + asset.data.length, 0);
    if (total > ASSETS_MAX_BYTES) {
      return {
        ok: false,
        error: `An artifact's files weigh at most ${ASSETS_MAX_BYTES / 1024 / 1024} MB together.`,
      };
    }
    return { ok: true, assets };
  }

  function pageTooBig(html: string) {
    return Buffer.byteLength(html) > PAGE_MAX_BYTES
      ? `The page is over ${PAGE_MAX_BYTES / 1024} KB.`
      : null;
  }

  // The artifact the agent names, when it is of the space the thread works in.
  function ownArtifact(id: string, ctx: Pick<ToolContext, "spaceId">) {
    const record = store.find(id);
    return record && record.spaceId === ctx.spaceId ? record : null;
  }

  function missing(id: string) {
    return failed(`No artifact ${id} in this space. artifact.list shows its artifacts.`);
  }

  function summaryOf(record: ArtifactRecord) {
    const current = store.version(record.id, record.version);
    return {
      id: record.id,
      title: current?.title ?? "",
      description: current?.description ?? "",
      version: record.version,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  const publishTool: ToolSpec<PublishInput> = {
    name: ARTIFACT_TOOLS.publish,
    title: "Publish",
    annotations: { readOnlyHint: false },
    description:
      "Publish a new HTML page as an artifact of this space: its first version. The page's <title> names it. The space's members see it until someone shares it wider.",
    input: z.object({
      html: htmlSchema,
      description: descriptionSchema,
      icon: iconSchema,
      label: labelSchema.optional(),
      assets: assetsSchema.optional(),
    }),
    risk: () => "normal",
    run(input, ctx) {
      const big = pageTooBig(input.html);
      if (big) return failed(big);
      const files = assetsOf(input.assets);
      if (!files.ok) return failed(files.error);
      const id = ulid();
      const title = titleOf(input.html);
      ctx.write(() =>
        store.create({
          id,
          spaceId: ctx.spaceId,
          threadId: rootOf(ctx.threadId).id,
          version: {
            html: input.html,
            title,
            description: input.description,
            icon: input.icon,
            label: input.label ?? null,
            runId: ctx.runId,
            callId: ctx.callId,
          },
          assets: files.assets,
        }),
      );
      const event = {
        type: "published",
        artifactId: id,
        version: 1,
        label: input.label ?? null,
        title,
      } as const;
      publish(event);
      return Promise.resolve({ ok: true, value: { id, version: 1, title } });
    },
  };

  const updateTool: ToolSpec<UpdateInput> = {
    name: ARTIFACT_TOOLS.update,
    title: "Update",
    annotations: { readOnlyHint: false },
    description:
      "Publish a new version of one of this space's artifacts, whichever thread made it. Give the whole page as html, or small changes as edits: each old text must occur exactly once, applied in order, all or none. basedOn is the version you built on; when a newer one exists the update is refused with its page to merge into. Description, icon and files carry over unless given.",
    input: z
      .object({
        id: idSchema,
        basedOn: z
          .number()
          .int()
          .positive()
          .optional()
          .meta({ title: "Based on", description: "The version you read and changed" }),
        html: htmlSchema.optional(),
        edits: z
          .array(editSchema)
          .min(1)
          .max(64)
          .optional()
          .meta({ title: "Edits", description: "Find-and-replace pairs on the current page" }),
        label: labelSchema.optional(),
        description: descriptionSchema.optional(),
        icon: iconSchema.optional(),
        assets: assetsSchema.optional(),
        removeAssets: z
          .array(z.string())
          .max(ASSETS_MAX)
          .optional()
          .meta({ title: "Remove files", description: "Names of files to drop" }),
      })
      .refine((input) => !(input.html !== undefined && input.edits !== undefined), {
        message: "Give html or edits, not both",
      }),
    risk: () => "normal",
    run(input, ctx) {
      const record = ownArtifact(input.id, ctx);
      if (!record) return missing(input.id);
      const current = store.version(record.id, record.version);
      if (!current) return missing(input.id);
      if (input.basedOn !== undefined && input.basedOn !== record.version) {
        return failed(
          `Version ${record.version} is the latest; you built on ${input.basedOn}. Merge your change into it and update again with basedOn ${record.version}. Its page:\n\n${current.html}`,
        );
      }
      let html = input.html ?? current.html;
      if (input.edits) {
        const edited = applyEdits(current.html, input.edits);
        if (!edited.ok) return failed(edited.error);
        html = edited.html;
      }
      const big = pageTooBig(html);
      if (big) return failed(big);
      const removed = input.removeAssets ?? [];
      const kept = store.assets(record.id).filter((asset) => !removed.includes(asset.name));
      const files = assetsOf(input.assets, kept);
      if (!files.ok) return failed(files.error);
      const title = titleOf(html);
      const label = input.label ?? null;
      const added = ctx.write(() =>
        store.addVersion(record.id, record.version, {
          version: {
            html,
            title,
            description: input.description ?? current.description,
            icon: input.icon ?? current.icon,
            label,
            runId: ctx.runId,
            callId: ctx.callId,
          },
          threadId: rootOf(ctx.threadId).id,
          assets: files.assets,
          removed,
        }),
      );
      if (!added) return missing(input.id);
      if ("stale" in added) {
        return failed(`Version ${added.stale} was published meanwhile. Read it and update again.`);
      }
      publish({ type: "published", artifactId: record.id, version: added.version, label, title });
      return Promise.resolve({
        ok: true,
        value: { id: record.id, version: added.version, title },
      });
    },
  };

  const readTool: ToolSpec<{ id: string; version?: number }> = {
    name: ARTIFACT_TOOLS.read,
    title: "Read",
    annotations: { readOnlyHint: true },
    description:
      "Read one of this space's artifacts: its page as written, its versions and its files. The newest version unless one is given.",
    input: z.object({
      id: idSchema,
      version: z.number().int().positive().optional().meta({ title: "Version" }),
    }),
    risk: () => "normal",
    run({ id, version }, ctx) {
      const record = ownArtifact(id, ctx);
      if (!record) return missing(id);
      const page = store.version(record.id, version ?? record.version);
      if (!page) return failed(`${id} has no version ${version}.`);
      ctx.write(() => store.use(record.id, rootOf(ctx.threadId).id));
      return Promise.resolve({
        ok: true,
        value: {
          id: record.id,
          version: page.version,
          latest: record.version,
          title: page.title,
          description: page.description,
          icon: page.icon,
          label: page.label,
          sharing: record.sharing,
          html: page.html,
          versions: store
            .versions(record.id)
            .map(({ version: number, label }) => ({ version: number, label })),
          assets: store.assets(record.id),
        },
      });
    },
  };

  const listTool: ToolSpec<{ scope?: "thread" | "space" }> = {
    name: ARTIFACT_TOOLS.list,
    title: "List",
    annotations: { readOnlyHint: true },
    description:
      "Artifacts with their newest versions: those this thread used, oldest first, or with scope space all of the space's, last changed first.",
    input: z.object({
      scope: artifactScopeSchema
        .optional()
        .meta({ title: "Scope", description: "thread (default) or space" }),
    }),
    risk: () => "normal",
    run({ scope }, ctx) {
      const records =
        scope === "space"
          ? store.inSpace(ctx.spaceId)
          : store
              .inThread(rootOf(ctx.threadId).id)
              .filter((record) => record.spaceId === ctx.spaceId);
      return Promise.resolve({ ok: true, value: { artifacts: records.map(summaryOf) } });
    },
  };

  const previewTool: ToolSpec<{ id: string; version?: number }> = {
    name: ARTIFACT_TOOLS.preview,
    title: "Preview",
    annotations: { readOnlyHint: true },
    description:
      "Render one of this space's artifacts at desktop and phone width, in light and dark, and report horizontal overflow, colours that ignore the theme, loads the policy blocked and console errors. One call returns the whole report; call it at most once before publishing.",
    input: z.object({
      id: idSchema,
      version: z.number().int().positive().optional().meta({ title: "Version" }),
    }),
    usefulIn: () => previewer !== null,
    risk: () => "normal",
    async run({ id, version }, ctx) {
      const record = ownArtifact(id, ctx);
      if (!record) return missing(id);
      if (!previewer) return failed("Previews are not available on this server.");
      if (version !== undefined && !store.version(record.id, version)) {
        return failed(`${id} has no version ${version}.`);
      }
      const { token } = await sign(
        { sub: record.id, ...(version && { v: version }) },
        PREVIEW_TTL_MS,
      );
      try {
        const report: PreviewReport = await previewer.preview({
          url: `${originOf(PREVIEW_ORIGIN, record.id)}${CONTENT_PREFIX}/v/${token}/`,
          handle: (request) => Promise.resolve(contentApp.fetch(request)),
          ...(ctx.signal && { signal: ctx.signal }),
        });
        return { ok: true, value: report };
      } catch (err) {
        return { ok: false, error: `The preview failed: ${(err as Error).message}` };
      }
    },
  };

  return {
    // Answers requests to the artifacts' origin.
    content: (request: Request) => contentApp.fetch(request),

    // Whether the request is for an origin artifacts are served from, and so for `content`.
    servesHost: (request: Request) =>
      options.artifactOrigin !== null &&
      isArtifactHost(options.artifactOrigin, new URL(request.url).host),

    toolset(): Toolset {
      return {
        id: ARTIFACT_TOOLSET,
        title: "Artifacts",
        description: "HTML pages the agent publishes in a space",
        source: "builtin",
        tools: [publishTool, updateTool, readTool, listTool, previewTool],
        guidance: ARTIFACT_GUIDANCE,
      };
    },

    // The artifacts the thread used that the person can view, for a thread they can read.
    inThread(principal: Principal, threadId: string): Artifact[] {
      const { thread } = access.require(principal, threadId, "read");
      return store
        .inThread(thread.rootThreadId ?? thread.id)
        .filter((record) => record.spaceId === thread.spaceId)
        .filter((record) => canView(principal, record))
        .map((record) => shown(record, principal));
    },

    // The artifacts the person can open across their org, last changed first, a page at a time
    // (the cursor is how many came before).
    list(principal: Principal, query: ArtifactListQuery): Page<ArtifactListItem> {
      const matching: ArtifactListItem[] = [];
      for (const record of store.inOrg(principal.orgId)) {
        if (!canView(principal, record)) continue;
        const space = spaceOf(record);
        const current = store.version(record.id, record.version);
        if (!space || !current) continue;
        const madeIn = record.createdInThreadId ? threads.find(record.createdInThreadId) : null;
        matching.push({
          id: record.id,
          title: current.title,
          description: current.description,
          icon: current.icon,
          version: record.version,
          updatedAt: record.updatedAt.toISOString(),
          sharing: record.sharing,
          madeIn:
            madeIn && access.can(principal, madeIn, "read")
              ? { id: madeIn.id, title: madeIn.title }
              : null,
          space: shownSpace(principal, space),
        });
      }
      const start = Number(query.cursor) || 0;
      const limit = query.limit ?? PAGE_LIMIT;
      const end = start + limit;
      return {
        items: matching.slice(start, end),
        nextCursor: end < matching.length ? String(end) : null,
        total: matching.length,
      };
    },

    detail(principal: Principal, id: string): ArtifactDetail {
      const record = requireViewable(principal, id);
      const space = spaceOf(record);
      const origin = options.artifactOrigin;
      const open = record.sharing === "public" && !!space && publicAllowed(space);
      const member = space && spaces.can(principal, space, "read") ? space : null;
      // A thread the person can read, as a link to it.
      const readable = (threadId: string | null) => {
        const thread = threadId ? threads.find(threadId) : null;
        return thread && access.can(principal, thread, "read")
          ? { id: thread.id, title: thread.title }
          : null;
      };
      return {
        ...shown(record, principal),
        madeIn: readable(record.createdInThreadId),
        usedIn: store.usedIn(record.id).flatMap((id) => readable(id) ?? []),
        space: member ? shownSpace(principal, member) : null,
        publicUrl:
          open && origin !== null
            ? `${originOf(origin, record.id)}${CONTENT_PREFIX}/p/${record.id}/`
            : null,
        versions: store.versions(record.id).map((version) => ({
          version: version.version,
          label: version.label,
          title: version.title,
          createdAt: version.createdAt.toISOString(),
          thread: readable(version.threadId ?? null),
        })),
      };
    },

    // A link that opens the artifact on its own origin for this person alone, for a while.
    async view(
      principal: Principal,
      id: string,
      request: ArtifactViewRequest,
    ): Promise<ArtifactView> {
      const record = requireViewable(principal, id);
      if (options.artifactOrigin === null) {
        throw new ServiceError(409, "This server has no origin to show artifacts on");
      }
      if (request.version !== undefined && !store.version(record.id, request.version)) {
        throw new ServiceError(404, "Version not found");
      }
      const { token, expiresAt } = await sign(
        {
          sub: record.id,
          uid: principal.userId,
          org: principal.orgId,
          ...(request.version && { v: request.version }),
        },
        VIEW_TTL_MS,
      );
      const query = request.theme ? `?theme=${request.theme}` : "";
      return {
        url: `${originOf(options.artifactOrigin, record.id)}${CONTENT_PREFIX}/v/${token}/${query}`,
        expiresAt: expiresAt.toISOString(),
      };
    },

    // Shares the artifact at the level; only those who can post in its space may, and public only
    // while the org and the space allow it.
    setSharing(principal: Principal, id: string, sharing: ArtifactSharing): Artifact {
      const record = requireViewable(principal, id);
      const space = spaceOf(record);
      if (!space) throw new ServiceError(404, "Artifact not found");
      const levels = levelsFor(principal, space);
      if (levels.length === 0) {
        throw new ServiceError(403, "Only the space's messagers and owners can share artifacts");
      }
      if (!levels.includes(sharing)) {
        throw new ServiceError(
          403,
          blockedFor(principal, space).find((one) => one.level === sharing)?.reason ??
            "Not allowed",
        );
      }
      store.setSharing(record.id, sharing);
      publish({ type: "sharing", artifactId: record.id, sharing });
      return shown({ ...record, sharing }, principal);
    },

    // Deletes the artifact with all its versions and files, for everyone; only those who can post
    // in its space may.
    delete(principal: Principal, id: string) {
      const record = requireViewable(principal, id);
      const space = spaceOf(record);
      if (!space || !mayChange(principal, space)) {
        throw new ServiceError(403, "Only the space's messagers and owners can delete artifacts");
      }
      store.delete(record.id);
      publish({ type: "deleted", artifactId: record.id });
    },

    // Calls the listener with what happens to an artifact the person may view, until unsubscribed.
    follow(principal: Principal, id: string, listener: (event: ArtifactEvent) => void) {
      requireViewable(principal, id);
      feed.on(id, listener);
      return () => void feed.off(id, listener);
    },

    // Whether the person may still view it, for streams that check as they go.
    viewable(principal: Principal, id: string) {
      const record = store.find(id);
      return !!record && canView(principal, record);
    },

    orgSettings(principal: Principal): ArtifactSettings {
      const allowed = store.orgPublicAllowed(principal.orgId);
      return {
        publicAllowed: allowed,
        orgPublicAllowed: allowed,
        canManage: principal.role === "owner",
      };
    },

    setOrgSettings(principal: Principal, publicAllowed: boolean): ArtifactSettings {
      if (principal.role !== "owner") {
        throw new ServiceError(403, "Only the organization's owners can do this");
      }
      store.setOrgPublicAllowed(principal.orgId, publicAllowed);
      return this.orgSettings(principal);
    },

    spaceSettings(principal: Principal, spaceId: string): ArtifactSettings {
      const space = spaces.require(principal, spaceId, "read");
      return {
        publicAllowed: store.spacePublicAllowed(space.id),
        orgPublicAllowed: store.orgPublicAllowed(space.orgId),
        canManage: space.manage,
      };
    },

    setSpaceSettings(principal: Principal, spaceId: string, publicAllowed: boolean) {
      const space = spaces.require(principal, spaceId, "manage");
      store.setSpacePublicAllowed(space.id, publicAllowed);
      return this.spaceSettings(principal, spaceId);
    },
  };
}
