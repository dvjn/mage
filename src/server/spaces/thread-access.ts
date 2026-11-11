// The one rule for what a person may do in a thread. Members of its space act as their role there
// allows; anyone else may act only as a guest of that one thread, given access while theirs lasts or
// through the thread being shared with its org, reading it and, when their role is to message,
// posting in it, changing their own waiting messages, and stopping or retrying the agent.
// Everything else about the thread and its space stays with the space's members. In an archived
// space a guest only reads, and in one in trash not even that. A subagent's thread is reached as
// the thread that started its subagents is.

import type { GuestStore } from "@/server/guests/service.ts";
import type { Directory } from "@/server/orgs/directory.ts";
import type { Principal } from "@/server/orgs/identity.ts";
import type { ThreadRole } from "@/shared/guests.ts";
import type { Thread, ThreadStore } from "@/server/threads/service.ts";
import { ServiceError } from "@/server/kernel/errors.ts";

import type { SpaceRole, SpaceAction, Spaces } from "./service.ts";

export interface ThreadAccessOptions {
  spaces: Pick<Spaces, "can" | "findVisible" | "require" | "isArchived" | "isGone" | "orgOf">;
  threads: Pick<ThreadStore, "find">;
  guests: Pick<GuestStore, "find" | "hostSpaceName" | "orgAccess" | "groupRole">;
  directory: Pick<Directory, "roleIn">;
  now?: () => Date;
}

export type ThreadAccess = ReturnType<typeof createThreadAccess>;

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

type Who = Pick<Principal, "userId" | "orgId">;

export function createThreadAccess(options: ThreadAccessOptions) {
  const { spaces, threads, guests, directory } = options;
  const now = options.now ?? (() => new Date());

  // Whether the person was a guest of the thread, and whether that access still holds.
  function guestOf(who: Who, thread: Thread) {
    const guest = guests.find(thread.rootThreadId ?? thread.id, who.userId);
    if (!guest || spaces.isGone(thread.spaceId)) return null;
    const ended = !!guest.revokedAt || (!!guest.accessUntil && guest.accessUntil <= now());
    return { ended, role: guest.role };
  }

  // What the thread being shared with the org lets the person do: when they are in the org and
  // the space is not gone.
  function orgRole(who: Who, thread: Thread): ThreadRole | null {
    const orgId = spaces.orgOf(thread.spaceId);
    if (!orgId || spaces.isGone(thread.spaceId) || !directory.roleIn(orgId, who.userId)) {
      return null;
    }
    const shared = guests.orgAccess(thread.rootThreadId ?? thread.id);
    return shared === "none" ? null : shared;
  }

  // How the person may come to the thread: through their role in its space, as a guest whose
  // access has not ended or through a group that has it, or through its general access for the
  // org, with the more they are given; null when none.
  function of(who: Who, thread: Thread): Access | null {
    const space = spaces.findVisible(who, thread.spaceId);
    if (space) return { via: "space", role: space.role };
    const guest = guestOf(who, thread);
    const own = guest && !guest.ended ? guest.role : null;
    const grouped = spaces.isGone(thread.spaceId)
      ? null
      : guests.groupRole(thread.rootThreadId ?? thread.id, who.userId, now());
    const given = own === "message" || grouped === "message" ? "message" : (own ?? grouped);
    const org = orgRole(who, thread);
    const role = given === "message" || org === "message" ? "message" : (given ?? org);
    if (!role) return null;
    return {
      via: "guest",
      spaceName: guests.hostSpaceName(thread.rootThreadId ?? thread.id) ?? "",
      role,
      viaOrg: given === null,
    };
  }

  function guestMay(
    access: Extract<Access, { via: "guest" }>,
    thread: Thread,
    action: ThreadAction,
  ) {
    if (action === "read") return true;
    return (
      GUEST_ALLOWED.includes(action) &&
      access.role === "message" &&
      !spaces.isArchived(thread.spaceId)
    );
  }

  return {
    of,

    can(who: Who, thread: Thread, action: ThreadAction) {
      const space = spaces.findVisible(who, thread.spaceId);
      if (space) return spaces.can(who, space, SPACE_ACTION[action]);
      const via = of(who, thread);
      return via?.via === "guest" && guestMay(via, thread, action);
    },

    // The thread and how the principal comes to it, when they may take the action. A thread they
    // cannot reach is not found, so its existence does not leak; a guest whose access has ended is
    // told so; one they can reach but not act on is forbidden.
    require(principal: Principal, id: string, action: ThreadAction = "read") {
      const thread = threads.find(id);
      if (!thread) throw new ServiceError(404, "Thread not found");
      const access = of(principal, thread);
      if (!access) {
        if (guestOf(principal, thread)?.ended) {
          throw new ServiceError(410, "Your access to this thread has ended", "access_ended");
        }
        throw new ServiceError(404, "Thread not found");
      }
      if (access.via === "space") spaces.require(principal, thread.spaceId, SPACE_ACTION[action]);
      else if (!GUEST_ALLOWED.includes(action)) {
        throw new ServiceError(403, "Guests of a thread cannot do this");
      } else if (access.role !== "message" && action !== "read") {
        throw new ServiceError(403, "You can only read this thread");
      } else if (!guestMay(access, thread, action)) {
        throw new ServiceError(403, "This space is archived");
      }
      return { thread, access };
    },
  };
}
