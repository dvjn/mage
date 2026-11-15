// Artifacts: HTML pages the agent publishes in a space, each publish a version, with the files
// they load. They belong to the space, not to a thread: every thread there can read and update
// them, and they follow the space's retention and deletion. People view them on an origin of their
// own, apart from the app's, through links the app signs for one viewer and one artifact for a
// short while; the app's session never reaches that origin. The space's members may view its
// artifacts; sharing widens that to its org's members, or anyone with a link, which the org and
// the space must both allow, and to the guests of a thread that used one, thread by thread, and to
// people picked one by one. The org's members and each person picked may be given the right to
// edit, which lets them change who it is shared with, and a thread's guests only view. Those who
// can post in the space may also delete it. Nobody edits its page: the agent publishes and updates
// artifacts with its tools.

import { createHmac } from "node:crypto";
import type { ArtifactHint, Signals } from "@/server/sync/signals.ts";

import { Hono } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { ulid } from "ulid";
import * as z from "zod";

import type { Toolset, ToolSpec, ToolContext } from "@/server/tools/registry.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Directory } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { ArtifactRole } from "@/shared/artifacts.ts";
import type { Space, SpaceStore, Spaces } from "@/server/spaces/service.ts";
import { spaceNameFor } from "@/shared/spaces.ts";
import type { ThreadAccess } from "@/server/access/access.ts";
import { type Page, PAGE_LIMIT } from "@/shared/paging.ts";
import type { GuestStore } from "@/server/guests/service.ts";
import type { ThreadStore } from "@/server/threads/types.ts";
import {
  ARTIFACT_TOOLS,
  ARTIFACT_TOOLSET,
  type Artifact,
  type ArtifactCandidate,
  type ArtifactDetail,
  type ArtifactEvent,
  type ArtifactListItem,
  type ArtifactListQuery,
  type ArtifactSettings,
  type ArtifactSharing,
  type ArtifactTheme,
  type ThreadArtifact,
  type ArtifactView,
  type ArtifactViewRequest,
  ARTIFACT_NOT_SHARED,
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
import { everyAsync, filterAsync, mapAsync, someAsync } from "@/server/kernel/async.ts";

export interface ArtifactRecord {
  id: string;
  spaceId: string;
  createdInThreadId: string | null;
  sharing: ArtifactSharing;
  // What the org's members may do while it is shared with them.
  orgRole: ArtifactRole;
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

// What published a version: the call, by its id in the thread.
interface Publisher {
  callId: string | null;
}

type NewVersion = VersionFields & { html: string } & Publisher;

function publisherOf(ctx: ToolContext): Publisher {
  return { callId: ctx.callId };
}

export interface ArtifactStore {
  create(artifact: {
    id: string;
    spaceId: string;
    threadId: string;
    version: NewVersion;
    assets: NewAsset[];
  }): Promise<void>;
  find(id: string): Promise<ArtifactRecord | null>;
  // The artifacts the thread used, oldest first.
  inThread(threadId: string): Promise<ArtifactRecord[]>;
  // The space's artifacts, last changed first.
  inSpace(spaceId: string): Promise<ArtifactRecord[]>;
  // Notes that the thread used the artifact.
  use(id: string, threadId: string): Promise<void>;
  // The threads that used the artifact, earliest first.
  usedIn(id: string): Promise<string[]>;
  // The threads whose guests the artifact is shared with.
  guestShares(id: string): Promise<string[]>;
  // Shares the artifact with the thread's guests, by the user; null stops.
  setGuestShare(id: string, threadId: string, by: string | null): Promise<void>;
  // The people given access to the artifact, earliest first, with what they may do.
  people(id: string): Promise<{ userId: string; role: ArtifactRole }[]>;
  // What the person was given to do, or null when they were not given it.
  personRole(id: string, userId: string): Promise<ArtifactRole | null>;
  // The artifacts given to the person, last changed first.
  sharedWith(userId: string): Promise<ArtifactRecord[]>;
  // Gives the person access as the role, by the user, or changes their role; null takes it back.
  setPersonShare(id: string, userId: string, by: string | null, role: ArtifactRole): Promise<void>;
  // The directory groups given access to the artifact, earliest first, with what they may do.
  groups(id: string): Promise<{ groupId: string; role: ArtifactRole }[]>;
  // The most the person may do through the groups they are active in that the artifact's org
  // still links; null when none was given access.
  groupRole(id: string, userId: string): Promise<ArtifactRole | null>;
  // Gives the group access as the role, by the user, or changes its role; null takes it back.
  setGroupShare(id: string, groupId: string, by: string | null, role: ArtifactRole): Promise<void>;
  // Every artifact of the org's spaces, last changed first.
  inOrg(orgId: string): Promise<ArtifactRecord[]>;
  version(id: string, version: number): Promise<(VersionRecord & { html: string }) | null>;
  // Newest first, without their pages.
  versions(id: string): Promise<VersionRecord[]>;
  // Adds the next version, when the newest is still `basedOn`; else says which is.
  addVersion(
    id: string,
    basedOn: number,
    change: { version: NewVersion; threadId: string; assets: NewAsset[]; removed: string[] },
  ): Promise<{ version: number } | { stale: number } | null>;
  assets(id: string): Promise<{ name: string; contentType: string; size: number }[]>;
  asset(id: string, name: string): Promise<{ contentType: string; data: Buffer } | null>;
  setSharing(id: string, sharing: ArtifactSharing): Promise<void>;
  setOrgRole(id: string, orgRole: ArtifactRole): Promise<void>;
  delete(id: string): Promise<void>;
  orgPublicAllowed(orgId: string): Promise<boolean>;
  setOrgPublicAllowed(orgId: string, allowed: boolean): Promise<void>;
  spacePublicAllowed(spaceId: string): Promise<boolean>;
  setSpacePublicAllowed(spaceId: string, allowed: boolean): Promise<void>;
}

export interface ArtifactsOptions {
  store: ArtifactStore;
  // Where open viewers, on whichever instance, hear of changes.
  signals: Pick<Signals, "artifactChanged" | "subscribeArtifact" | "onGap">;
  threads: Pick<ThreadStore, "find">;
  spaceStore: Pick<SpaceStore, "find">;
  spaces: Pick<Spaces, "findVisible" | "can" | "require" | "isGone">;
  access: Pick<ThreadAccess, "can" | "require">;
  guests: Pick<GuestStore, "reachedIn">;
  directory: Pick<
    Directory,
    "roleIn" | "user" | "memberPage" | "group" | "groupPage" | "linkedRole" | "memberCount"
  >;
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

// The most people a search for someone to give an artifact offers, and groups beside them.
const CANDIDATES_MAX = 20;
const GROUPS_MAX = 5;

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
  async function shownSpace(principal: Principal, space: Space) {
    const owner = space.createdBy ? (await directory.user(space.createdBy))?.name : null;
    const own = space.createdBy === principal.userId;
    return { id: space.id, name: spaceNameFor(space, owner ?? "A former member", own) };
  }
  const now = options.now ?? (() => new Date());
  const previewer = options.previewer ?? null;
  const key = createHmac("sha256", options.secret).update(AUDIENCE).digest();
  // Viewers are told what changed by a hint, and read it themselves.
  function publish(event: ArtifactEvent) {
    options.signals.artifactChanged(
      event.type === "published"
        ? { type: "published", artifactId: event.artifactId, version: event.version }
        : { type: event.type, artifactId: event.artifactId },
    );
  }

  // What a viewer is told of a hint, as the artifact now is; none once what it tells of is gone.
  async function eventOf(hint: ArtifactHint): Promise<ArtifactEvent | null> {
    if (hint.type === "deleted") return hint;
    if (hint.type === "sharing") {
      const record = await store.find(hint.artifactId);
      return record && { type: "sharing", artifactId: record.id, sharing: record.sharing };
    }
    const version = await store.version(hint.artifactId, hint.version);
    return (
      version && {
        type: "published",
        artifactId: hint.artifactId,
        version: version.version,
        label: version.label,
        title: version.title,
      }
    );
  }

  // The thread an agent's work is recorded on: the root of the one it runs in.
  async function rootOf(threadId: string) {
    const thread = await threads.find(threadId);
    if (!thread) throw new Error("the thread is gone");
    return thread.rootThreadId ? ((await threads.find(thread.rootThreadId)) ?? thread) : thread;
  }

  async function spaceOf(record: ArtifactRecord) {
    return spaceStore.find(record.spaceId);
  }

  // Whether the org and the space let the space's artifacts be made public.
  async function publicAllowed(space: { id: string; orgId: string }) {
    return (
      (await store.orgPublicAllowed(space.orgId)) && (await store.spacePublicAllowed(space.id))
    );
  }

  // Whether the viewer may view the artifact: the agent always; the space's members; while its
  // space is not gone, whoever can read a thread it is shared with the guests of; and as far as its
  // sharing reaches, the org's members, or anyone, while the org and the space allow it.
  async function canView(viewer: Viewer, record: ArtifactRecord) {
    const space = await spaceOf(record);
    if (!space) return false;
    if (viewer && "agent" in viewer) return true;
    if (viewer && (await spaces.can(viewer, space, "read"))) return true;
    if (await spaces.isGone(space.id)) return false;
    if (viewer && (await readsAThread(viewer, await store.guestShares(record.id)))) return true;
    if (viewer && (await givenRole(record, space, viewer.userId))) return true;
    const level = LEVELS.indexOf(record.sharing);
    if (level >= 2 && (await publicAllowed(space))) return true;
    if (!viewer || viewer.orgId !== space.orgId) return false;
    return level >= 1 && !!(await directory.roleIn(space.orgId, viewer.userId));
  }

  // What the person was given to do with the artifact, when they still may have it: one by one while
  // in its org or a guest of a thread that used it, who only views, or through a group, the most
  // either gives.
  async function givenRole(
    record: ArtifactRecord,
    space: Space,
    userId: string,
  ): Promise<ArtifactRole | null> {
    const member = !!(await directory.roleIn(space.orgId, userId));
    const own = await store.personRole(record.id, userId);
    const single =
      own && (await couldBeGiven(record, space, userId)) ? (member ? own : "view") : null;
    const grouped = member ? await store.groupRole(record.id, userId) : null;
    return single === "edit" || grouped === "edit" ? "edit" : (single ?? grouped);
  }

  async function isGuestOfUse(record: ArtifactRecord, userId: string) {
    return await someAsync(await store.usedIn(record.id), async (threadId) =>
      (await options.guests.reachedIn(threadId, now())).some((guest) => guest.userId === userId),
    );
  }

  async function couldBeGiven(record: ArtifactRecord, space: Space, userId: string) {
    return !!(await directory.roleIn(space.orgId, userId)) || (await isGuestOfUse(record, userId));
  }

  async function readsAThread(viewer: { userId: string; orgId: string }, threadIds: string[]) {
    return await someAsync(threadIds, async (threadId) => {
      const thread = await threads.find(threadId);
      return !!thread && (await access.can(viewer, thread, "read"));
    });
  }

  // Whether the person may delete artifacts of the space: those who can post in it.
  async function mayDelete(principal: Principal, space: Space) {
    return principal.orgId === space.orgId && (await spaces.can(principal, space, "message"));
  }

  // Whether the person was given the right to edit the artifact: by its sharing with the org, or
  // one by one.
  async function isEditor(
    principal: Pick<Principal, "userId" | "orgId">,
    record: ArtifactRecord,
    space: Space,
  ) {
    // Membership of the artifact's org counts, whichever org the person has open.
    if (!(await directory.roleIn(space.orgId, principal.userId))) return false;
    if (record.sharing === "org" && record.orgRole === "edit") return true;
    return (await givenRole(record, space, principal.userId)) === "edit";
  }

  // Whether the person may change who the artifact is shared with: those who can post in its space,
  // and those given the right to edit it.
  async function mayChange(principal: Principal, record: ArtifactRecord, space: Space) {
    return (await mayDelete(principal, space)) || (await isEditor(principal, record, space));
  }

  // The levels the person may share the artifact at, none when they may not change it.
  async function levelsFor(principal: Principal, record: ArtifactRecord, space: Space) {
    if (!(await mayChange(principal, record, space))) return [];
    return await filterAsync(
      LEVELS,
      async (level) => level !== "public" || (await publicAllowed(space)),
    );
  }

  // Why the person may not share at all, said for every level; a level only public is closed to
  // is left out of the levels instead.
  async function blockedFor(
    principal: Principal,
    record: ArtifactRecord,
    space: Space,
  ): Promise<{ level: ArtifactSharing; reason: string }[]> {
    if ((await levelsFor(principal, record, space)).length > 0) return [];
    return LEVELS.map((level) => ({
      level,
      reason: "Only those who can edit this artifact can share it",
    }));
  }

  async function shown(record: ArtifactRecord, principal: Principal): Promise<Artifact> {
    const space = await spaceOf(record);
    const current = await store.version(record.id, record.version);
    if (!space || !current) throw new ServiceError(404, "Artifact not found");
    const levels = await levelsFor(principal, record, space);
    return {
      id: record.id,
      spaceId: space.id,
      title: current.title,
      description: current.description,
      icon: current.icon,
      version: record.version,
      label: current.label,
      sharing: record.sharing,
      orgRole: record.orgRole,
      assets: await store.assets(record.id),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      canShare: levels.length > 0,
      canDelete: await mayDelete(principal, space),
      sharingLevels: levels,
      sharingBlocked: await blockedFor(principal, record, space),
      locked: false,
    };
  }

  // What a thread shows of an artifact its reader may not open: its name, and nothing else.
  async function lockedOf(record: ArtifactRecord): Promise<Artifact | null> {
    const current = await store.version(record.id, record.version);
    if (!current) return null;
    return {
      id: record.id,
      spaceId: record.spaceId,
      title: current.title,
      description: "",
      icon: current.icon,
      version: record.version,
      label: null,
      sharing: "space",
      orgRole: "view",
      assets: [],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      canShare: false,
      canDelete: false,
      sharingLevels: [],
      sharingBlocked: [],
      locked: true,
    };
  }

  // The artifact when the person may view it; one they may not is not found.
  async function requireViewable(principal: Principal, id: string) {
    const record = await store.find(id);
    if (!record || !(await canView(principal, record))) {
      throw new ServiceError(404, "Artifact not found");
    }
    return record;
  }

  // The artifact and its space, for one who may change it.
  async function requireChange(principal: Principal, id: string) {
    const record = await requireViewable(principal, id);
    const space = await spaceOf(record);
    if (!space || !(await mayChange(principal, record, space))) {
      throw new ServiceError(403, "Only those who can edit this artifact can share it");
    }
    return { record, space };
  }

  // What the person already has of the artifact, and in what words: through their role in its
  // space, one by one, through a group or as the org's, when they do. `full` is all there is to
  // give them: to edit it, or for a guest of a thread, who only views, to view it.
  async function holds(record: ArtifactRecord, space: Space, userId: string) {
    const who = { userId, orgId: space.orgId };
    const member = !!(await directory.roleIn(space.orgId, userId));
    if (!member && (await givenRole(record, space, userId)))
      return { full: true, label: "Has access" };
    const seat = member ? (await spaces.findVisible(who, space.id))?.role : undefined;
    if (seat === "owner") return { full: true, label: "Owner" };
    if (seat === "messager") return { full: true, label: "In the space · Message" };
    if (
      member &&
      ((await spaces.can(who, space, "message")) || (await isEditor(who, record, space)))
    ) {
      return { full: true, label: "Has access" };
    }
    if (seat === "viewer") return { full: false, label: "In the space · View" };
    if (member && (await givenRole(record, space, userId))) {
      return { full: false, label: "Can view" };
    }
    if (member && record.sharing !== "space") {
      return { full: false, label: "Can view" };
    }
    return null;
  }

  // Whether the person may be given the artifact: in its org or a guest of a thread that used it,
  // and not able to edit it already; one who can only view it may be given more.
  async function candidateOf(record: ArtifactRecord, space: Space, userId: string) {
    if (!(await couldBeGiven(record, space, userId))) return null;
    const had = await holds(record, space, userId);
    if (had?.full) return null;
    return { guest: !(await directory.roleIn(space.orgId, userId)), current: had?.label ?? null };
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
  async function content(
    request: Request,
    record: ArtifactRecord | null,
    viewer: Viewer,
    version: number | null,
    name: string | null,
    theme: ArtifactTheme | null,
  ) {
    if (!record || !(await canView(viewer, record)) || !onOwnHost(request, record.id))
      return notFound();
    if (name) {
      const asset = await store.asset(record.id, name);
      if (!asset) return notFound();
      return new Response(new Uint8Array(asset.data), {
        headers: contentHeaders(asset.contentType),
      });
    }
    const page = await store.version(record.id, version ?? record.version);
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
    return content(
      request,
      await store.find(link.id),
      link.viewer,
      link.version,
      name,
      themeOf(theme),
    );
  }

  async function shared(
    request: Request,
    id: string,
    name: string | null,
    theme: string | undefined,
  ) {
    const record = await store.find(id);
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
    .get(`${CONTENT_PREFIX}/p/:id/`, async (c) =>
      shared(c.req.raw, c.req.param("id"), null, c.req.query("theme")),
    )
    .get(`${CONTENT_PREFIX}/p/:id/:name`, async (c) =>
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
  async function ownArtifact(id: string, ctx: Pick<ToolContext, "spaceId">) {
    const record = await store.find(id);
    return record && record.spaceId === ctx.spaceId ? record : null;
  }

  // Whether the thread's guests may have the artifact in the agent's hands: it is shared with
  // them, or each of them could view it anyway. Without active guests everything is within bounds.
  async function withinGuestBounds(record: ArtifactRecord, ctx: Pick<ToolContext, "threadId">) {
    const rootId = (await rootOf(ctx.threadId)).id;
    const guests = await options.guests.reachedIn(rootId, now());
    if (guests.length === 0 || (await store.guestShares(record.id)).includes(rootId)) return true;
    const space = await spaceOf(record);
    return (
      !!space &&
      (await everyAsync(guests, async (guest) =>
        canView({ userId: guest.userId, orgId: space.orgId }, record),
      ))
    );
  }

  function outOfBounds() {
    return failed(
      "Not shared with this thread's guests. Someone who can share it can give them access.",
    );
  }

  function missing(id: string) {
    return failed(`No artifact ${id} in this space. artifact.list shows its artifacts.`);
  }

  async function summaryOf(record: ArtifactRecord) {
    const current = await store.version(record.id, record.version);
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
      "Publish a new HTML page as an artifact of this space: its first version. The page's <title> names it. The space's members see it until someone shares it wider; the thread's guests can open it.",
    input: z.object({
      html: htmlSchema,
      description: descriptionSchema,
      icon: iconSchema,
      label: labelSchema.optional(),
      assets: assetsSchema.optional(),
    }),
    risk: () => "normal",
    async run(input, ctx) {
      const big = pageTooBig(input.html);
      if (big) return failed(big);
      const files = assetsOf(input.assets);
      if (!files.ok) return failed(files.error);
      const id = ulid();
      const title = titleOf(input.html);
      await ctx.write(async () =>
        store.create({
          id,
          spaceId: ctx.spaceId,
          threadId: (await rootOf(ctx.threadId)).id,
          version: {
            html: input.html,
            title,
            description: input.description,
            icon: input.icon,
            label: input.label ?? null,
            ...publisherOf(ctx),
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
    async run(input, ctx) {
      const record = await ownArtifact(input.id, ctx);
      if (!record) return missing(input.id);
      if (!(await withinGuestBounds(record, ctx))) return outOfBounds();
      const current = await store.version(record.id, record.version);
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
      const kept = (await store.assets(record.id)).filter((asset) => !removed.includes(asset.name));
      const files = assetsOf(input.assets, kept);
      if (!files.ok) return failed(files.error);
      const title = titleOf(html);
      const label = input.label ?? null;
      const added = await ctx.write(async () =>
        store.addVersion(record.id, record.version, {
          version: {
            html,
            title,
            description: input.description ?? current.description,
            icon: input.icon ?? current.icon,
            label,
            ...publisherOf(ctx),
          },
          threadId: (await rootOf(ctx.threadId)).id,
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
    async run({ id, version }, ctx) {
      const record = await ownArtifact(id, ctx);
      if (!record) return missing(id);
      if (!(await withinGuestBounds(record, ctx))) return outOfBounds();
      const page = await store.version(record.id, version ?? record.version);
      if (!page) return failed(`${id} has no version ${version}.`);
      await ctx.write(async () => store.use(record.id, (await rootOf(ctx.threadId)).id));
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
          versions: (await store.versions(record.id)).map(({ version: number, label }) => ({
            version: number,
            label,
          })),
          assets: await store.assets(record.id),
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
    async run({ scope }, ctx) {
      const records =
        scope === "space"
          ? await store.inSpace(ctx.spaceId)
          : (await store.inThread((await rootOf(ctx.threadId)).id)).filter(
              (record) => record.spaceId === ctx.spaceId,
            );
      return Promise.resolve({
        ok: true,
        value: {
          artifacts: await mapAsync(
            await filterAsync(records, async (record) => withinGuestBounds(record, ctx)),
            summaryOf,
          ),
        },
      });
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
      const record = await ownArtifact(id, ctx);
      if (!record) return missing(id);
      if (!previewer) return failed("Previews are not available on this server.");
      if (version !== undefined && !(await store.version(record.id, version))) {
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
    async inThread(principal: Principal, threadId: string): Promise<ThreadArtifact[]> {
      const { thread } = await access.require(principal, threadId, "read");
      const rootId = thread.rootThreadId ?? thread.id;
      const guests = (await options.guests.reachedIn(rootId, now())).length;
      const space = await spaceStore.find(thread.spaceId);
      const shares = new Set(
        (
          await filterAsync(await store.inThread(rootId), async (record) =>
            (await store.guestShares(record.id)).includes(rootId),
          )
        ).map((record) => record.id),
      );
      return (
        await Promise.all(
          (await store.inThread(rootId))
            .filter((record) => record.spaceId === thread.spaceId)
            .map(async (record): Promise<ThreadArtifact[]> => {
              if (!(await canView(principal, record))) {
                const locked = await lockedOf(record);
                return locked ? [{ ...locked, guests: null }] : [];
              }
              const change = !!space && (await mayChange(principal, record, space));
              return [
                {
                  ...(await shown(record, principal)),
                  guests:
                    guests > 0 && change
                      ? { count: guests, shared: shares.has(record.id), canChange: true }
                      : null,
                },
              ];
            }),
        )
      ).flat();
    },

    // The artifacts the person can open across their org, last changed first, a page at a time
    // (the cursor is how many came before).
    async list(principal: Principal, query: ArtifactListQuery): Promise<Page<ArtifactListItem>> {
      const matching: ArtifactListItem[] = [];
      const given = await store.sharedWith(principal.userId);
      const records = [
        ...(await store.inOrg(principal.orgId)),
        ...(await filterAsync(
          given,
          async (one) => (await spaceOf(one))?.orgId !== principal.orgId,
        )),
      ].toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1));
      for (const record of records) {
        if (!(await canView(principal, record))) continue;
        const space = await spaceOf(record);
        const current = await store.version(record.id, record.version);
        if (!space || !current) continue;
        const madeIn = record.createdInThreadId
          ? await threads.find(record.createdInThreadId)
          : null;
        matching.push({
          id: record.id,
          title: current.title,
          description: current.description,
          icon: current.icon,
          version: record.version,
          updatedAt: record.updatedAt.toISOString(),
          sharing: record.sharing,
          madeIn:
            madeIn && (await access.can(principal, madeIn, "read"))
              ? { id: madeIn.id, title: madeIn.title }
              : null,
          space: await shownSpace(principal, space),
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

    async detail(principal: Principal, id: string): Promise<ArtifactDetail> {
      const found = await store.find(id);
      if (
        found &&
        !(await canView(principal, found)) &&
        (await readsAThread(principal, await store.usedIn(id)))
      ) {
        throw new ServiceError(403, "This artifact is not shared with you", ARTIFACT_NOT_SHARED);
      }
      const record = await requireViewable(principal, id);
      const space = await spaceOf(record);
      const origin = options.artifactOrigin;
      const open = record.sharing === "public" && !!space && (await publicAllowed(space));
      const member = space && (await spaces.can(principal, space, "read")) ? space : null;
      // A thread the person can read, as a link to it.
      const readable = async (threadId: string | null) => {
        const thread = threadId ? await threads.find(threadId) : null;
        return thread && (await access.can(principal, thread, "read"))
          ? { id: thread.id, title: thread.title }
          : null;
      };
      const shares = new Set(await store.guestShares(record.id));
      const guestThreads =
        !space || !(await mayChange(principal, record, space))
          ? []
          : (
              await mapAsync(await store.usedIn(record.id), async (threadId) => {
                const thread = await threads.find(threadId);
                const guests = thread
                  ? (await options.guests.reachedIn(thread.id, now())).length
                  : 0;
                return thread && guests > 0
                  ? [{ id: thread.id, title: thread.title, guests, shared: shares.has(thread.id) }]
                  : [];
              })
            ).flat();
      const people =
        !space || !(await mayChange(principal, record, space))
          ? []
          : (
              await Promise.all(
                (await store.people(record.id)).map(async ({ userId, role }) => {
                  const person = await directory.user(userId);
                  return person
                    ? [
                        {
                          userId,
                          name: person.name,
                          email: person.email,
                          former: !(await couldBeGiven(record, space, userId)),
                          guest: !(await directory.roleIn(space.orgId, userId)),
                          role: (await directory.roleIn(space.orgId, userId))
                            ? role
                            : ("view" as const),
                        },
                      ]
                    : [];
                }),
              )
            ).flat();
      const groups =
        !space || !(await mayChange(principal, record, space))
          ? []
          : (
              await mapAsync(await store.groups(record.id), async ({ groupId, role }) => {
                const group = await directory.group(groupId);
                return group
                  ? [
                      {
                        groupId,
                        name: group.name,
                        memberCount: await directory.memberCount(groupId),
                        role,
                      },
                    ]
                  : [];
              })
            ).flat();
      return {
        ...(await shown(record, principal)),
        guestThreads,
        groups,
        people,
        madeIn: await readable(record.createdInThreadId),
        usedIn: (
          await Promise.all(
            (await store.usedIn(record.id)).map(async (id) => (await readable(id)) ?? []),
          )
        ).flat(),
        space: member ? await shownSpace(principal, member) : null,
        publicUrl:
          open && origin !== null
            ? `${originOf(origin, record.id)}${CONTENT_PREFIX}/p/${record.id}/`
            : null,
        versions: await Promise.all(
          (await store.versions(record.id)).map(async (version) => ({
            version: version.version,
            label: version.label,
            title: version.title,
            createdAt: version.createdAt.toISOString(),
            thread: await readable(version.threadId ?? null),
          })),
        ),
      };
    },

    // A link that opens the artifact on its own origin for this person alone, for a while.
    async view(
      principal: Principal,
      id: string,
      request: ArtifactViewRequest,
    ): Promise<ArtifactView> {
      const record = await requireViewable(principal, id);
      if (options.artifactOrigin === null) {
        throw new ServiceError(409, "This server has no origin to show artifacts on");
      }
      if (request.version !== undefined && !(await store.version(record.id, request.version))) {
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

    // Shares the artifact at the level, and sets what the org's members may do when asked; only
    // those who can change it may, and public only while the org and the space allow it.
    async setSharing(
      principal: Principal,
      id: string,
      sharing: ArtifactSharing,
      orgRole?: ArtifactRole,
    ): Promise<Artifact> {
      const record = await requireViewable(principal, id);
      const space = await spaceOf(record);
      if (!space) throw new ServiceError(404, "Artifact not found");
      const levels = await levelsFor(principal, record, space);
      if (levels.length === 0) {
        throw new ServiceError(403, "Only those who can edit this artifact can share it");
      }
      if (!levels.includes(sharing)) {
        throw new ServiceError(
          403,
          (await blockedFor(principal, record, space)).find((one) => one.level === sharing)
            ?.reason ?? "Not allowed",
        );
      }
      const role = orgRole ?? record.orgRole;
      await store.setSharing(record.id, sharing);
      if (role !== record.orgRole) await store.setOrgRole(record.id, role);
      publish({ type: "sharing", artifactId: record.id, sharing });
      return shown({ ...record, sharing, orgRole: role }, principal);
    },

    // Shares the artifact with the guests of a thread that used it, or stops; only those who can
    // change it may.
    async setGuestShare(
      principal: Principal,
      id: string,
      threadId: string,
      shared: boolean,
    ): Promise<ArtifactDetail> {
      const record = await requireViewable(principal, id);
      const space = await spaceOf(record);
      if (!space || !(await mayChange(principal, record, space))) {
        throw new ServiceError(403, "Only those who can edit this artifact can share it");
      }
      if (!(await store.usedIn(record.id)).includes(threadId)) {
        throw new ServiceError(404, "That thread did not use this artifact");
      }
      await store.setGuestShare(record.id, threadId, shared ? principal.userId : null);
      publish({ type: "sharing", artifactId: record.id, sharing: record.sharing });
      return this.detail(principal, id);
    },

    // Who the artifact may be given to, matching the text in their name or email: the org's groups,
    // its members and the guests of the threads that used it, those who have it already too, with
    // why, and the level of those who could have more; at most 20 people and a few groups. Only
    // those who can change it may ask.
    async candidates(
      principal: Principal,
      id: string,
      q: string | undefined,
    ): Promise<ArtifactCandidate[]> {
      const { record, space } = await requireChange(principal, id);
      const text = q?.trim().toLowerCase() ?? "";
      const out: ArtifactCandidate[] = [];
      const seen = new Set<string>([principal.userId]);
      const held = new Set((await store.groups(record.id)).map((row) => row.groupId));
      const groups = (
        await directory.groupPage(space.orgId, { ...(text && { q: text }), limit: GROUPS_MAX })
      ).items.map((group): ArtifactCandidate => ({
        kind: "group",
        id: group.id,
        name: group.name,
        email: group.email ?? "",
        guest: false,
        memberCount: group.memberCount,
        already: held.has(group.id) ? "Added" : null,
        current: null,
      }));
      const add = async (userId: string) => {
        if (seen.has(userId) || out.length >= CANDIDATES_MAX) return;
        seen.add(userId);
        const person = await directory.user(userId);
        if (!person || !(await couldBeGiven(record, space, userId))) return;
        if (text && !`${person.name}\n${person.email}`.toLowerCase().includes(text)) return;
        const had = await holds(record, space, userId);
        out.push({
          kind: "user",
          id: userId,
          name: person.name,
          email: person.email,
          guest: !(await directory.roleIn(space.orgId, userId)),
          memberCount: null,
          already: had?.full ? had.label : null,
          current: had && !had.full ? had.label : null,
        });
      };
      for (const threadId of await store.usedIn(record.id)) {
        for (const guest of await options.guests.reachedIn(threadId, now()))
          await add(guest.userId);
      }
      let cursor: string | undefined;
      do {
        const page = await directory.memberPage(space.orgId, {
          ...(text && { q: text }),
          limit: 100,
          ...(cursor && { cursor }),
        });
        for (const member of page.items) await add(member.id);
        cursor = out.length >= CANDIDATES_MAX ? undefined : (page.nextCursor ?? undefined);
      } while (cursor);
      return [...groups, ...out];
    },

    // Gives the person access to the artifact to view or to edit, changes what they were given,
    // or takes it back; only those who can change it may, and only for a candidate or one already
    // given it. A guest of a thread only views.
    async setPersonShare(
      principal: Principal,
      id: string,
      userId: string,
      shared: boolean,
      role: ArtifactRole = "view",
    ): Promise<ArtifactDetail> {
      const { record, space } = await requireChange(principal, id);
      const already = (await store.personRole(record.id, userId)) !== null;
      if (shared ? !already && !(await candidateOf(record, space, userId)) : !already) {
        throw new ServiceError(404, "That person cannot be given this artifact");
      }
      if (shared && role === "edit" && !(await directory.roleIn(space.orgId, userId))) {
        throw new ServiceError(400, "A guest of a thread can only view an artifact");
      }
      await store.setPersonShare(record.id, userId, shared ? principal.userId : null, role);
      publish({ type: "sharing", artifactId: record.id, sharing: record.sharing });
      return this.detail(principal, id);
    },

    // Gives everyone in a group of the artifact's org access to view or to edit while they are in
    // it, changes what the group was given, or takes it back; only those who can change it may.
    async setGroupShare(
      principal: Principal,
      id: string,
      groupId: string,
      shared: boolean,
      role: ArtifactRole = "view",
    ): Promise<ArtifactDetail> {
      const { record, space } = await requireChange(principal, id);
      const already = (await store.groups(record.id)).some((row) => row.groupId === groupId);
      if (shared ? !(await directory.linkedRole(space.orgId, groupId)) : !already) {
        throw new ServiceError(404, "That group cannot be given this artifact");
      }
      await store.setGroupShare(record.id, groupId, shared ? principal.userId : null, role);
      publish({ type: "sharing", artifactId: record.id, sharing: record.sharing });
      return this.detail(principal, id);
    },

    // Deletes the artifact with all its versions and files, for everyone; only those who can post
    // in its space may.
    async delete(principal: Principal, id: string) {
      const record = await requireViewable(principal, id);
      const space = await spaceOf(record);
      if (!space || !(await mayDelete(principal, space))) {
        throw new ServiceError(403, "Only the space's messagers and owners can delete artifacts");
      }
      await store.delete(record.id);
      publish({ type: "deleted", artifactId: record.id });
    },

    // Calls the listener with what happens to an artifact the person may view, until stopped; a
    // read that fails, as of a database gone away, is given to `failed`, and nothing more is told.
    // `recheck` reads the artifact again without a hint, as a hint may be lost, and tells what
    // changed since the listener was last told.
    async follow(
      principal: Principal,
      id: string,
      listener: (event: ArtifactEvent) => void,
      failed: (err: unknown) => void = () => {},
    ) {
      const record = await requireViewable(principal, id);
      let told = { version: record.version, sharing: record.sharing };
      let broken = false;
      // Told in the order heard, one read after another.
      let telling: Promise<void> = Promise.resolve();
      const tell = (events: () => Promise<(ArtifactEvent | null)[]>) => {
        telling = telling
          .then(async () => {
            if (broken) return;
            for (const event of await events()) {
              if (!event) continue;
              if (event.type === "published") told = { ...told, version: event.version };
              if (event.type === "sharing") told = { ...told, sharing: event.sharing };
              listener(event);
            }
          })
          .catch((err: unknown) => {
            if (err instanceof ServiceError) return;
            broken = true;
            failed(err);
          });
        return telling;
      };
      const stopHints = options.signals.subscribeArtifact(id, (hint) =>
        tell(async () => [await eventOf(hint)]),
      );
      // After a gap in what this instance heard, the viewer is told the artifact as it now is.
      const stopGaps = options.signals.onGap(() =>
        tell(async () => {
          const record = await store.find(id);
          if (!record) return [{ type: "deleted", artifactId: id }];
          return [
            await eventOf({ type: "published", artifactId: id, version: record.version }),
            { type: "sharing", artifactId: id, sharing: record.sharing },
          ];
        }),
      );
      return {
        stop: () => {
          stopHints();
          stopGaps();
        },
        recheck: async () =>
          tell(async () => {
            const now = await store.find(id);
            if (!now) return [{ type: "deleted", artifactId: id }];
            return [
              now.version === told.version
                ? null
                : await eventOf({ type: "published", artifactId: id, version: now.version }),
              now.sharing === told.sharing
                ? null
                : { type: "sharing", artifactId: id, sharing: now.sharing },
            ];
          }),
      };
    },

    // Whether the person may still view it, for streams that check as they go.
    async viewable(principal: Principal, id: string) {
      const record = await store.find(id);
      return !!record && (await canView(principal, record));
    },

    async orgSettings(principal: Principal): Promise<ArtifactSettings> {
      const allowed = await store.orgPublicAllowed(principal.orgId);
      return {
        publicAllowed: allowed,
        orgPublicAllowed: allowed,
        canManage: principal.role === "owner",
      };
    },

    async setOrgSettings(principal: Principal, publicAllowed: boolean): Promise<ArtifactSettings> {
      if (principal.role !== "owner") {
        throw new ServiceError(403, "Only the organization's owners can do this");
      }
      await store.setOrgPublicAllowed(principal.orgId, publicAllowed);
      return this.orgSettings(principal);
    },

    async spaceSettings(principal: Principal, spaceId: string): Promise<ArtifactSettings> {
      const space = await spaces.require(principal, spaceId, "read");
      return {
        publicAllowed: await store.spacePublicAllowed(space.id),
        orgPublicAllowed: await store.orgPublicAllowed(space.orgId),
        canManage: space.manage,
      };
    },

    async setSpaceSettings(principal: Principal, spaceId: string, publicAllowed: boolean) {
      const space = await spaces.require(principal, spaceId, "manage");
      await store.setSpacePublicAllowed(space.id, publicAllowed);
      return this.spaceSettings(principal, spaceId);
    },
  };
}
