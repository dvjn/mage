// Arranges what the app has no screens for yet, for the tests and the browser journeys: someone
// made a member of another person's space, and threads already full of what a journey scrolls
// through. Its routes are mounted only on a server run for tests, where they also answer what the
// database's rules find broken.

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import * as z from "zod";

import type { Db } from "@/server/db/db.ts";
import type { GuestStore } from "@/server/guests/service.ts";
import { member, session, user } from "@/server/orgs/schema.ts";
import { space, spaceMember } from "@/server/spaces/schema.ts";
import type { SpaceRole } from "@/server/spaces/service.ts";
import type { ThreadLog } from "@/server/threads/log.ts";
import type { NewEvent, ThreadReadStore, ThreadStore } from "@/server/threads/service.ts";
import {
  type ActorSummary,
  type AnyThreadEvent,
  anyThreadEventSchema,
} from "@/shared/threads/events.ts";

import { invariants } from "./invariants.ts";

export interface SeedOptions {
  db: Db;
  threads: Pick<ThreadStore, "create" | "listInSpace">;
  guests: Pick<GuestStore, "grant">;
  reads: Pick<ThreadReadStore, "mark">;
  log: ThreadLog;
}

export type Seed = ReturnType<typeof createSeed>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Makes the user a member of the space with the role, in its org, and points their sessions at
// that org. A tab of theirs still open names its own org with each request, which points the
// session back.
export function joinSpace(
  db: Db,
  userId: string,
  joined: { id: string; orgId: string },
  role: SpaceRole,
) {
  db.insert(member)
    .values({
      id: ulid(),
      organizationId: joined.orgId,
      userId,
      role: "member",
      directRole: "member",
      createdAt: new Date(),
    })
    .run();
  db.update(session)
    .set({ activeOrganizationId: joined.orgId })
    .where(eq(session.userId, userId))
    .run();
  db.insert(spaceMember)
    .values({ spaceId: joined.id, subjectKind: "user", subjectId: userId, role, source: "direct" })
    .run();
}

// The value with every string that is a key of `names` replaced by what it names, however deep.
function renamed(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return names.get(value) ?? value;
  if (Array.isArray(value)) return value.map((one) => renamed(one, names));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [key, renamed(one, names)]),
    );
  }
  return value;
}

export function createSeed({ db, threads, guests, reads, log }: SeedOptions) {
  // When the last thread added here was made; each one added after it is newer by a time of its
  // own, so lists sorted by it come out the same every time.
  let lastAdded = 0;
  function nextTime() {
    lastAdded = Math.max(Date.now(), lastAdded + 1);
    return new Date(lastAdded);
  }

  function userId(email: string) {
    const row = db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
    if (!row) throw new Error(`no user ${email}`);
    return row.id;
  }

  // The person's primary space. Someone who has just signed up may not have it yet: their page
  // can show a moment before the sign-up has made it.
  async function primarySpaceOf(email: string) {
    const owner = userId(email);
    const until = Date.now() + 2000;
    for (;;) {
      const row = db
        .select({ id: space.id, orgId: space.organizationId })
        .from(space)
        .where(and(eq(space.createdBy, owner), eq(space.primary, true)))
        .get();
      if (row) return { ...row, userId: owner };
      if (Date.now() > until) throw new Error(`no primary space for ${email}`);
      await pause(20);
    }
  }

  return {
    // Makes the user with `email` a member of the primary space of the user with `ownerEmail`,
    // answering its org's id.
    async joinSpace(input: { ownerEmail: string; email: string; role: "messager" | "viewer" }) {
      const joined = await primarySpaceOf(input.ownerEmail);
      joinSpace(db, userId(input.email), joined, input.role);
      return { orgId: joined.orgId };
    },

    // Adds `count` threads, titled `${prefix} 1` and on, to the person's primary space, each newer
    // than the last.
    async threads(input: { email: string; count: number; prefix: string }) {
      const home = await primarySpaceOf(input.email);
      for (let index = 1; index <= input.count; index += 1) {
        threads.create({
          spaceId: home.id,
          model: null,
          createdBy: home.userId,
          title: `${input.prefix} ${index}`,
          titleSource: "message",
          at: nextTime(),
        });
      }
      return {};
    },

    // Makes the user with `guestEmail` a guest, with no expiry, in every thread of the primary
    // space of the user with `ownerEmail`.
    async shareThreads(input: { ownerEmail: string; guestEmail: string }) {
      const home = await primarySpaceOf(input.ownerEmail);
      const guest = userId(input.guestEmail);
      for (const thread of threads.listInSpace(home.id)) {
        guests.grant({
          threadId: thread.id,
          userId: guest,
          invitedBy: home.userId,
          accessUntil: null,
        });
      }
      return {};
    },

    // Adds a thread titled `title` to the person's primary space, holding `count` asides from
    // them, `Note 1` and on, each a few lines long, which they have seen; then as many more as
    // `unread` says from the user it names, which they have not. Answers its id.
    async notesThread(input: {
      email: string;
      title: string;
      count: number;
      unread?: { email: string; count: number };
    }) {
      const home = await primarySpaceOf(input.email);
      const other = input.unread && userId(input.unread.email);
      const authors = [
        ...Array.from({ length: input.count }, () => home.userId),
        ...Array.from({ length: input.unread?.count ?? 0 }, () => other!),
      ];
      const at = nextTime();
      const thread = threads.create({
        spaceId: home.id,
        model: null,
        createdBy: home.userId,
        title: input.title,
        titleSource: "person",
        at,
      });
      // Writing its notes makes it active now, which must be after the threads added before it.
      while (Date.now() <= at.getTime()) await pause(1);
      const start = Date.now() - authors.length;
      log.write(thread.id, (append) => {
        authors.forEach((author, index) => {
          const text = `Note ${index + 1}\n\nA line to give it height.\n\nAnd one more.`;
          append({
            type: "message",
            actor: { kind: "user", userId: author },
            data: { parts: [{ type: "text", text }], quiet: true, mode: "steer" },
            createdAt: new Date(start + index + 1),
          });
        });
      });
      reads.mark(home.userId, thread.id, input.count, new Date());
      return { threadId: thread.id };
    },

    // Adds a thread titled `title` to the person's primary space whose log is the events given,
    // in their order. Where the events name each other by id they name the stored ones instead,
    // and the user ids in `people` stand for the users with those emails; `thread` stands for the
    // thread itself. Answers its id and the stored id of each event by the id it was given under.
    async events(input: {
      email: string;
      title: string;
      events: AnyThreadEvent[];
      people?: Record<string, string>;
    }) {
      const home = await primarySpaceOf(input.email);
      const thread = threads.create({
        spaceId: home.id,
        model: null,
        createdBy: home.userId,
        title: input.title,
        titleSource: "person",
        at: nextTime(),
      });
      const names = new Map<string, string>([["thread", thread.id]]);
      for (const [name, email] of Object.entries(input.people ?? {}))
        names.set(name, userId(email));
      const ids: Record<string, string> = {};
      log.write(thread.id, (append) => {
        for (const event of input.events) {
          const actor = renamed(event.actor, names) as ActorSummary;
          const stored = append({
            type: event.type,
            actor: actor.kind === "user" ? { kind: "user", userId: actor.userId } : actor,
            data: renamed(event.data, names),
            createdAt: new Date(event.createdAt),
          } as NewEvent);
          names.set(event.id, stored.id);
          ids[event.id] = stored.id;
        }
      });
      return { threadId: thread.id, ids };
    },

    invariants: () => invariants(db),
  };
}

const seedSchema = z.union([
  z.object({
    joinSpace: z.object({
      ownerEmail: z.string(),
      email: z.string(),
      role: z.enum(["messager", "viewer"]),
    }),
  }),
  z.object({
    threads: z.object({
      email: z.string(),
      count: z.number().int().positive(),
      prefix: z.string(),
    }),
  }),
  z.object({ shareThreads: z.object({ ownerEmail: z.string(), guestEmail: z.string() }) }),
  z.object({
    events: z.object({
      email: z.string(),
      title: z.string(),
      events: z.array(anyThreadEventSchema),
      people: z.record(z.string(), z.string()).optional(),
    }),
  }),
  z.object({
    notesThread: z.object({
      email: z.string(),
      title: z.string(),
      count: z.number().int().nonnegative(),
      unread: z.object({ email: z.string(), count: z.number().int().positive() }).optional(),
    }),
  }),
]);

// Mounted under /api/test.
export function seedRoutes(seed: Seed) {
  return new Hono()
    .post("/seed", async (c) => {
      const input = seedSchema.parse(await c.req.json());
      if ("joinSpace" in input) return c.json(await seed.joinSpace(input.joinSpace));
      if ("threads" in input) return c.json(await seed.threads(input.threads));
      if ("shareThreads" in input) return c.json(await seed.shareThreads(input.shareThreads));
      if ("events" in input) return c.json(await seed.events(input.events));
      return c.json(await seed.notesThread(input.notesThread));
    })
    .get("/invariants", (c) => c.json({ violations: seed.invariants() }));
}
