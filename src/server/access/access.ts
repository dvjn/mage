// The one rule for what a person may do in a thread. Members of its space act as their role there
// allows; anyone else may act only as a guest of that one thread, given access while theirs lasts or
// through the thread being shared with its org, reading it and, when their role is to message,
// posting in it, changing their own waiting messages, and stopping or retrying the agent.
// Everything else about the thread and its space stays with the space's members. In an archived
// space a guest only reads, and in one in trash not even that. A subagent's thread is reached as
// the thread that started its subagents is.
// What the rule needs is read once into a reader: the thread, its space with the person's role
// there and whether it is archived, its org and the org's settings, and for someone who is not a
// member, their guest, group and org-wide access. The reader answers every question after that
// without reading again.

import type { GuestStore } from "@/server/guests/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";
import type { Directory, Org } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { OrgSettings, OrgSettingStore } from "@/server/orgs/service.ts";
import {
  archivedFrom,
  type Space,
  type SpaceAction,
  type SpaceRole,
  type SpaceStore,
  type Spaces,
} from "@/server/spaces/service.ts";
import type { Thread, ThreadStore } from "@/server/threads/service.ts";
import type { ThreadRole } from "@/shared/guests.ts";

export interface AccessOptions {
  spaceStore: Pick<SpaceStore, "find" | "roleOf">;
  spaces: Pick<Spaces, "allows" | "refuseUnless">;
  threads: Pick<ThreadStore, "find">;
  guests: Pick<GuestStore, "find" | "hostSpaceName" | "orgAccess" | "groupRole">;
  directory: Pick<Directory, "roleIn" | "org">;
  settings: Pick<OrgSettingStore, "get">;
  now?: () => Date;
}

export type ThreadAccess = ReturnType<typeof createAccess>;

// Reading the thread; posting, changing one's waiting messages, stopping and retrying the agent;
// renaming it and changing its model; inviting and revoking guests; leaving other people's
// messages out of its current branch; deleting it or moving it to another space.
export type ThreadAction = "read" | "post" | "arrange" | "share" | "rewrite" | "delete" | "move";

// What each action needs of a member's role in the space.
const SPACE_ACTION: Record<ThreadAction, SpaceAction> = {
  read: "read",
  post: "message",
  arrange: "message",
  share: "message",
  rewrite: "manage",
  delete: "remove",
  move: "remove",
};

const GUEST_ALLOWED: readonly ThreadAction[] = ["read", "post"];

// A guest sees the space's name and nothing else of it. `viaOrg` is set when the thread's general
// access for the org is all they have.
export type Access =
  | { via: "space"; role: SpaceRole }
  | { via: "guest"; spaceName: string; role: ThreadRole; viaOrg: boolean };

type Who = Pick<Principal, "userId" | "orgId"> & Partial<Pick<Principal, "role">>;

// A person before one thread, with everything the rule asks about read once. The space, the org
// and its settings are the thread's own, whoever reads it.
export interface Reader {
  principal: Who;
  thread: Thread;
  // Null once the space is gone.
  space: (Space & { role: SpaceRole | null; archived: boolean }) | null;
  org: Org | null;
  settings: OrgSettings | null;
  // How they come to the thread; null when they may not.
  via: Access | null;
  // Set when they were its guest and that access has ended.
  ended: boolean;
  // Whether they may take the action in the thread.
  can(action: ThreadAction): boolean;
  // Whether their standing in the thread's space allows the action there.
  canInSpace(action: SpaceAction): boolean;
}

export function createAccess(options: AccessOptions) {
  const { spaceStore, spaces, threads, guests, directory, settings } = options;
  const now = options.now ?? (() => new Date());

  // Reads what the rule needs to know of the person and the thread.
  async function reader(who: Who, thread: Thread): Promise<Reader> {
    const found = await spaceStore.find(thread.spaceId);
    const gone = !found || !!found.trashedAt;
    const role =
      found && found.orgId === who.orgId && !found.trashedAt
        ? await spaceStore.roleOf(found.id, who.userId)
        : null;
    const org = found && (await directory.org(found.orgId));
    const orgSettings = found && (await settings.get(found.orgId));
    const archived =
      !!found &&
      !!orgSettings &&
      (await archivedFrom(found, org, orgSettings, async () =>
        found.createdBy ? !!(await directory.roleIn(found.orgId, found.createdBy)) : false,
      ));
    const space = found && { ...found, role, archived };
    const root = thread.rootThreadId ?? thread.id;

    let via: Access | null = null;
    let ended = false;
    if (role) {
      via = { via: "space", role };
    } else {
      // A guest's own access, unless the space is gone; then any group's; then the org's.
      const guest = await guests.find(root, who.userId);
      const own =
        guest && !gone
          ? !!guest.revokedAt || (!!guest.accessUntil && guest.accessUntil <= now())
            ? ((ended = true), null)
            : guest.role
          : null;
      const grouped = gone ? null : await guests.groupRole(root, who.userId, now());
      const given = own === "message" || grouped === "message" ? "message" : (own ?? grouped);
      const inOrg = !gone && found && (await directory.roleIn(found.orgId, who.userId));
      const shared = inOrg ? await guests.orgAccess(root) : "none";
      const fromOrg = shared === "none" ? null : shared;
      const guestRole =
        given === "message" || fromOrg === "message" ? "message" : (given ?? fromOrg);
      if (guestRole) {
        via = {
          via: "guest",
          spaceName: (await guests.hostSpaceName(root)) ?? "",
          role: guestRole,
          viaOrg: given === null,
        };
      }
    }

    const standing = { role, archived };
    const canInSpace = (action: SpaceAction) =>
      !!space && spaces.allows(who, space, standing, action);
    return {
      principal: who,
      thread,
      space,
      org,
      settings: orgSettings,
      via,
      ended: !via && ended,
      canInSpace,
      can(action) {
        if (!via) return false;
        if (via.via === "space") return canInSpace(SPACE_ACTION[action]);
        if (action === "read") return true;
        // Every action a guest may take past reading needs what posting does.
        return GUEST_ALLOWED.includes(action) && via.role === "message" && !archived;
      },
    };
  }

  // The reader before the thread with the id, when they may take the action in it. A thread they
  // cannot reach is not found, so its existence does not leak; a guest whose access has ended is
  // told so; one they can reach but not act on is forbidden.
  async function require(principal: Principal, id: string, action: ThreadAction = "read") {
    const thread = await threads.find(id);
    if (!thread) throw new ServiceError(404, "Thread not found");
    const read = await reader(principal, thread);
    const { via } = read;
    if (!via) {
      if (read.ended) {
        throw new ServiceError(410, "Your access to this thread has ended", "access_ended");
      }
      throw new ServiceError(404, "Thread not found");
    }
    if (via.via === "space") {
      spaces.refuseUnless(principal, read.space!, read.space!, SPACE_ACTION[action]);
    } else if (!GUEST_ALLOWED.includes(action)) {
      throw new ServiceError(403, "Guests of a thread cannot do this");
    } else if (via.role !== "message" && action !== "read") {
      throw new ServiceError(403, "You can only read this thread");
    } else if (!read.can(action)) {
      throw new ServiceError(403, "This space is archived");
    }
    return read as Reader & { via: Access };
  }

  return {
    reader,
    require,

    // The reader before the thread, when they may come to it at all.
    async of(who: Who, thread: Thread): Promise<Reader | null> {
      const read = await reader(who, thread);
      return read.via ? read : null;
    },

    async can(who: Who, thread: Thread, action: ThreadAction) {
      return (await reader(who, thread)).can(action);
    },
  };
}
