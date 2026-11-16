import { and, asc, desc, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { ulid } from "ulid";

import type { Db } from "@/server/db/db.ts";
import { orgFormerMember, user } from "@/server/orgs/schema.ts";
import { space } from "@/server/spaces/schema.ts";
import { spokenText } from "@/shared/plain-text.ts";
import { LARGE_RESULT_CHARS } from "@/shared/threads/events.ts";
import { UNTITLED } from "@/shared/threads/thread.ts";

import { kept, listedThread, newestFirst, statused, type StatusedRow, windowOf } from "./lists.ts";
import { thread, threadBranch, threadBranchSource, threadEvent, toolResult } from "./schema.ts";
import type {
  Branch,
  NewEvent,
  StoredEvent,
  Thread,
  ThreadFacts,
  ThreadStore,
  ThreadWriters,
} from "./types.ts";
import { parentOf } from "./parent.ts";

// The events a reader is told about: a person's message, a finished reply and a failed run.
const NOTABLE = ["message", "message.completed", "run.failed"];

// Whether the event `threadEvent` is one of the branch's.
function ofBranch(branchId: SQL | string) {
  return sql`exists (select 1 from ${threadBranchSource} s
                      where s.branch_id = ${branchId}
                        and s.source_branch_id = ${threadEvent.branchId}
                        and (s.until_seq is null or ${threadEvent.seq} <= s.until_seq))`;
}

// Whether the event `threadEvent` is one of its thread's current branch.
// A thread's change is stamped by the database's clock, which the list feed asks what changed
// since by, whatever the clock of the instance that wrote it says.
const dbNow = sql`now()`;

const ofCurrent = ofBranch(
  sql`(select t.current_branch_id from ${thread} t where t.id = ${threadEvent.threadId})`,
);

const branchColumns = {
  id: threadBranch.id,
  threadId: threadBranch.threadId,
  parentBranchId: threadBranch.parentBranchId,
  forkSeq: threadBranch.forkSeq,
  kind: threadBranch.kind,
  rowId: threadBranch.rowId,
  groupRowId: threadBranch.groupRowId,
  createdBy: threadBranch.createdBy,
  createdByName: user.name,
  createdAt: threadBranch.createdAt,
};

const columns = {
  id: thread.id,
  spaceId: thread.spaceId,
  title: thread.title,
  titleSource: thread.titleSource,
  model: thread.model,
  effort: thread.effort,
  createdBy: thread.createdBy,
  parentThreadId: parentOf(thread.id),
  rootThreadId: thread.rootThreadId,
  currentBranchId: thread.currentBranchId,
  lastEventSeq: thread.lastEventSeq,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
};

// The event's data as the log holds it, and what its call gave back when that is too large for
// the log, to be kept apart.
function logged(event: NewEvent): { data: NewEvent["data"]; result?: unknown } {
  if (event.type !== "tool.ran" || !event.data.ok || event.data.large) return { data: event.data };
  const { value, ...rest } = event.data;
  const size = JSON.stringify(value)?.length ?? 0;
  if (size <= LARGE_RESULT_CHARS) return { data: event.data };
  return { data: { ...rest, large: { size } }, result: value };
}

export function createThreadStore(db: Db): ThreadStore {
  async function branchOf(id: string) {
    return (
      ((
        await db
          .select(branchColumns)
          .from(threadBranch)
          .leftJoin(user, eq(user.id, threadBranch.createdBy))
          .where(eq(threadBranch.id, id))
          .limit(1)
      )[0] as Branch | undefined) ?? null
    );
  }

  async function eventsWhere(
    where: SQL | undefined,
    order: "asc" | "desc" = "asc",
    limit?: number,
  ): Promise<StoredEvent[]> {
    return (
      await db
        .select({
          id: threadEvent.id,
          threadId: threadEvent.threadId,
          branchId: threadEvent.branchId,
          seq: threadEvent.seq,
          type: threadEvent.type,
          actorKind: threadEvent.actorKind,
          actorUserId: threadEvent.actorUserId,
          actorName: user.name,
          actorRemovedAt: orgFormerMember.removedAt,
          data: threadEvent.data,
          createdAt: threadEvent.createdAt,
        })
        .from(threadEvent)
        .leftJoin(user, eq(user.id, threadEvent.actorUserId))
        .innerJoin(thread, eq(thread.id, threadEvent.threadId))
        .innerJoin(space, eq(space.id, thread.spaceId))
        .leftJoin(
          orgFormerMember,
          and(
            eq(orgFormerMember.organizationId, space.organizationId),
            eq(orgFormerMember.userId, threadEvent.actorUserId),
          ),
        )
        .where(where)
        .orderBy(order === "asc" ? asc(threadEvent.seq) : desc(threadEvent.seq))
        .limit(limit ?? -1)
    ).map(
      ({ actorKind, actorUserId, actorName, actorRemovedAt, type, data, ...rest }) =>
        ({
          ...rest,
          type,
          data,
          actor:
            actorKind === "user" && actorUserId
              ? { kind: "user", userId: actorUserId }
              : { kind: "agent" },
          actorName: actorName ?? null,
          actorFormer: actorRemovedAt !== null,
        }) as StoredEvent,
    );
  }

  return {
    async userName(userId) {
      return (
        (await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))[0]
          ?.name ?? null
      );
    },

    // Its root branch takes its id. The thread names the branch before the branch is there, so
    // that link is checked when the transaction ends rather than as the thread is written.
    async create({ at, ...input }) {
      const id = ulid();
      return db.transaction(async () => {
        const created = (
          await db
            .insert(thread)
            .values({
              id,
              ...input,
              currentBranchId: id,
              ...(at && { createdAt: at, updatedAt: at }),
            })
            .returning(columns)
        )[0]!;
        await db
          .insert(threadBranch)
          .values({ id, threadId: id, kind: "root", createdBy: input.createdBy });
        await db.insert(threadBranchSource).values({ branchId: id, sourceBranchId: id });
        return created;
      });
    },

    async branches(threadId) {
      return (await db
        .select(branchColumns)
        .from(threadBranch)
        .leftJoin(user, eq(user.id, threadBranch.createdBy))
        .where(eq(threadBranch.threadId, threadId))
        .orderBy(asc(threadBranch.createdAt), asc(threadBranch.id))) as Branch[];
    },

    branch: branchOf,

    async eventAt(threadId, seq) {
      const [event] = await eventsWhere(
        and(eq(threadEvent.threadId, threadId), eq(threadEvent.seq, seq)),
      );
      return event ?? null;
    },

    async lastRan(threadId, callId) {
      const [event] = await eventsWhere(
        and(
          eq(threadEvent.threadId, threadId),
          eq(threadEvent.type, "tool.ran"),
          sql`${threadEvent.data}->>'callId' = ${callId}`,
          ofCurrent,
        ),
        "desc",
        1,
      );
      return event ?? null;
    },

    async eventsAt(threadId, seqs) {
      if (seqs.length === 0) return [];
      return await eventsWhere(
        and(eq(threadEvent.threadId, threadId), inArray(threadEvent.seq, [...seqs])),
      );
    },

    async changesOf(threadId, messageIds, branchId) {
      if (messageIds.length === 0) return [];
      return await eventsWhere(
        and(
          eq(threadEvent.threadId, threadId),
          eq(threadEvent.type, "message.changed"),
          inArray(sql`${threadEvent.data}->>'messageId'`, [...messageIds]),
          branchId ? ofBranch(branchId) : ofCurrent,
        ),
      );
    },

    async sources(branchId) {
      return await db
        .select({
          branchId: threadBranchSource.sourceBranchId,
          untilSeq: threadBranchSource.untilSeq,
        })
        .from(threadBranchSource)
        .where(eq(threadBranchSource.branchId, branchId));
    },

    // Takes its parent's sources, each up to the fork at most, then its own events.
    async addBranch(input) {
      const id = ulid();
      await db.transaction(async () => {
        await db.insert(threadBranch).values({ id, ...input });
        const inherited = await db
          .select()
          .from(threadBranchSource)
          .where(eq(threadBranchSource.branchId, input.parentBranchId));
        await db.insert(threadBranchSource).values([
          ...inherited.map((source) => ({
            branchId: id,
            sourceBranchId: source.sourceBranchId,
            untilSeq:
              source.untilSeq === null ? input.forkSeq : Math.min(source.untilSeq, input.forkSeq),
          })),
          { branchId: id, sourceBranchId: id },
        ]);
        if (input.kind === "restore") await db.execute(restoredPlace(sql`b.id = ${id}`));
      });
      return (await branchOf(id))!;
    },

    // What lists say of its newest message follows the branch.
    async setCurrent(threadId, branchId) {
      const [last] = await eventsWhere(
        and(
          eq(threadEvent.threadId, threadId),
          inArray(threadEvent.type, ["message", "message.completed"]),
          ofBranch(branchId),
        ),
        "desc",
        1,
      );
      const parts = (last?.data as { parts?: Parameters<typeof spokenText>[0] } | undefined)?.parts;
      return (
        await db
          .update(thread)
          .set({
            currentBranchId: branchId,
            lastMessageText: parts ? spokenText(parts) : null,
            updatedAt: dbNow,
          })
          .where(eq(thread.id, threadId))
          .returning(columns)
      )[0] as Thread;
    },

    async find(id): Promise<Thread | null> {
      return (await db.select(columns).from(thread).where(eq(thread.id, id)).limit(1))[0] ?? null;
    },

    async changedSince({ spaceIds, threadIds, userId, since, heldAtMost }) {
      const visible = [
        ...(spaceIds.length > 0 ? [inArray(thread.spaceId, [...spaceIds])] : []),
        ...(threadIds.length > 0
          ? [inArray(sql`coalesce(${thread.rootThreadId}, ${thread.id})`, [...threadIds])]
          : []),
      ];
      const seen = sql`(select max(r.seen_at) from thread_read r
                         where r.thread_id = ${thread.id} and r.user_id = ${userId})`;
      const changed = and(
        visible.length > 0 ? or(...visible) : sql`false`,
        sql`(${thread.updatedAt} >= ${since} or ${seen} >= ${since})`,
      );
      const row = (
        await db.execute<{ changes: { id: string; stamp: string }[] | null; at: Date | string }>(
          sql`select (select json_agg(json_build_object(
                         'id', ${thread.id},
                         'stamp', greatest(${thread.updatedAt}, ${seen})::text))
                        from ${thread} where ${changed}) as changes,
                     greatest(
                       least(now(), (select min(xact_start) from pg_stat_activity
                                      where datname = current_database()
                                        and usename = current_user
                                        and pid <> pg_backend_pid()
                                        and backend_type = 'client backend')),
                       now() - ${heldAtMost} * interval '1 millisecond') as at`,
        )
      ).rows[0]!;
      return {
        changes: new Map((row.changes ?? []).map(({ id, stamp }) => [id, stamp])),
        at: new Date(row.at),
      };
    },

    async findAll(ids) {
      if (ids.length === 0) return [];
      return await db
        .select(columns)
        .from(thread)
        .where(inArray(thread.id, [...ids]));
    },

    async listInSpace(spaceId) {
      return await db
        .select(columns)
        .from(thread)
        .where(and(eq(thread.spaceId, spaceId), isNull(thread.rootThreadId)))
        .orderBy(desc(thread.updatedAt), desc(thread.id));
    },

    // Read per thread from its newest events back, so the cost follows the threads listed rather
    // than the length of their logs.
    async facts(threadIds) {
      const facts = new Map<string, ThreadFacts>();
      if (threadIds.length === 0) return facts;
      const kinds = sql.join(
        NOTABLE.map((kind) => sql`${kind}`),
        sql`, `,
      );
      const newest = (types: SQL, columns: SQL) =>
        sql`(select ${columns} from ${threadEvent}
              where ${threadEvent.threadId} = t.id and ${threadEvent.type} in (${types}) and ${ofCurrent}
              order by ${threadEvent.seq} desc limit 1)`;
      const rows = await db.execute<{
        thread_id: string;
        notable: number | null;
        notable_by: string | null;
        run_seq: number | null;
        run_type: string | null;
        run_data: unknown;
      }>(sql`
        select t.id as thread_id, n.seq as notable, n.actor_user_id as notable_by,
               r.seq as run_seq, r.type as run_type, r.data as run_data
          from unnest(${sql`array[${sql.join(
            threadIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[]`}) as t(id)
          left join lateral ${newest(kinds, sql`${threadEvent.seq}, ${threadEvent.actorUserId}`)} n on true
          left join lateral ${newest(
            sql`'run.failed', 'run.created'`,
            sql`${threadEvent.seq}, ${threadEvent.type}, ${threadEvent.data}`,
          )} r on true
         where n.seq is not null or r.seq is not null`);
      for (const row of rows.rows) {
        // A run that failed after the last one began.
        const failedLast = row.run_type === "run.failed";
        facts.set(row.thread_id, {
          notable: row.notable === null ? null : { seq: row.notable, by: row.notable_by },
          failed: failedLast
            ? {
                seq: row.run_seq!,
                error: (row.run_data as { error?: string } | null)?.error ?? "",
              }
            : null,
        });
      }
      return facts;
    },

    async writers(threadIds) {
      const writers = new Map<string, ThreadWriters>();
      if (threadIds.length === 0) return writers;
      // Each writer's newest message in each thread.
      const rows = await db
        .selectDistinctOn([threadEvent.threadId, threadEvent.actorUserId], {
          threadId: threadEvent.threadId,
          userId: threadEvent.actorUserId,
          name: user.name,
          removedAt: orgFormerMember.removedAt,
          last: threadEvent.seq,
          guest: sql<boolean | null>`(${threadEvent.data}->>'guest')::boolean`,
        })
        .from(threadEvent)
        .leftJoin(user, eq(user.id, threadEvent.actorUserId))
        .innerJoin(thread, eq(thread.id, threadEvent.threadId))
        .innerJoin(space, eq(space.id, thread.spaceId))
        .leftJoin(
          orgFormerMember,
          and(
            eq(orgFormerMember.organizationId, space.organizationId),
            eq(orgFormerMember.userId, threadEvent.actorUserId),
          ),
        )
        .where(
          and(
            inArray(threadEvent.threadId, threadIds),
            eq(threadEvent.type, "message"),
            eq(threadEvent.actorKind, "user"),
            ofCurrent,
          ),
        )
        .orderBy(threadEvent.threadId, threadEvent.actorUserId, desc(threadEvent.seq));
      // Whoever wrote last comes first.
      rows.sort((one, other) => other.last - one.last);
      for (const { threadId, userId, name, removedAt, guest } of rows) {
        if (!userId) continue;
        writers.set(threadId, [
          ...(writers.get(threadId) ?? []),
          { userId, name, former: removedAt !== null, guest: !!guest },
        ]);
      }
      return writers;
    },

    async listed(reader, spaceId, filter, window) {
      const where = sql`t.space_id = ${spaceId} and t.root_thread_id is null`;
      const listed = statused(reader, { from: sql`from thread t`, where });
      const keep = kept(filter, sql`coalesce(title, ${UNTITLED})`, sql`last_message_text`);
      const rows = (
        await db.execute<StatusedRow & Record<string, unknown>>(
          sql`${listed} select * from statused where ${keep} ${newestFirst} ${windowOf(window)}`,
        )
      ).rows;
      const total = window
        ? ((
            await db.execute<{ n: number }>(
              sql`${listed} select count(*)::int as n from statused where ${keep}`,
            )
          ).rows[0]?.n ?? 0)
        : rows.length;
      return { rows: rows.map(listedThread), total };
    },

    async sidebar(reader, spaceId, limit) {
      const listed = statused(reader, {
        from: sql`from thread t`,
        where: sql`t.space_id = ${spaceId} and t.root_thread_id is null`,
      });
      const rows = (
        await db.execute<StatusedRow & Record<string, unknown>>(sql`${listed},
        placed as (
          select *,
                 row_number() over (${newestFirst}) as in_space,
                 row_number() over (partition by status ${newestFirst}) as in_status
            from statused
        )
        select * from placed
         where in_space <= ${limit}
            or (status <> 'read' and in_status = 1)
            or run_status = 'waiting'
            or subagent_waiting
            or job_waiting
            or (status = 'failed' and in_status <= ${limit})
         ${newestFirst}`)
      ).rows;
      const total = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from thread where space_id = ${spaceId} and root_thread_id is null`,
        )
      ).rows[0];
      const failed = (
        await db.execute<{ n: number }>(
          sql`${listed} select count(*)::int as n from statused where status = 'failed'`,
        )
      ).rows[0];
      return {
        rows: rows.map(listedThread),
        total: total?.n ?? 0,
        failed: failed?.n ?? 0,
      };
    },

    async anyInSpace(spaceId) {
      return !!(
        await db.select({ id: thread.id }).from(thread).where(eq(thread.spaceId, spaceId)).limit(1)
      )[0];
    },

    async search(spaceIds, text, limit, untitled) {
      if (spaceIds.length === 0) return [];
      // The text's own % and _ match only themselves.
      const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
      return await db
        .select(columns)
        .from(thread)
        .where(
          and(
            inArray(thread.spaceId, spaceIds),
            isNull(thread.rootThreadId),
            sql`lower(coalesce(${thread.title}, ${untitled})) like lower(${pattern}) escape '\\'`,
          ),
        )
        .orderBy(desc(thread.updatedAt), desc(thread.id))
        .limit(limit);
    },

    async update(id, changes) {
      return (
        await db
          .update(thread)
          .set({ ...changes, updatedAt: dbNow })
          .where(eq(thread.id, id))
          .returning(columns)
      )[0] as Thread;
    },

    async delete(id) {
      await db.delete(thread).where(or(eq(thread.id, id), eq(thread.rootThreadId, id)));
    },

    async children(id) {
      return await db
        .select(columns)
        .from(thread)
        .where(eq(thread.rootThreadId, id))
        .orderBy(asc(thread.createdAt), asc(thread.id));
    },

    async lock(ids) {
      await db
        .select({ id: thread.id })
        .from(thread)
        .where(inArray(thread.id, ids))
        .orderBy(asc(thread.id))
        .for("no key update");
    },

    // Into the branch, the current one when none is named; what lists say of the thread's newest
    // message follows its current branch alone.
    async append(threadId, event, title, branchId) {
      const id = ulid();
      const { data, result } = logged(event);
      await db.transaction(async (tx) => {
        const current = sql`${thread.currentBranchId}`;
        const branch = branchId ?? current;
        const next = (
          await tx
            .update(thread)
            .set({
              lastEventSeq: sql`${thread.lastEventSeq} + 1`,
              updatedAt: dbNow,
              ...(title !== undefined && {
                title: sql`coalesce(${thread.title}, ${title})`,
                titleSource: sql`coalesce(${thread.titleSource}, 'message')`,
              }),
              ...((event.type === "message" || event.type === "message.completed") && {
                lastMessageText: sql`case when ${branch} = ${current}
                                        then ${spokenText(event.data.parts)}
                                        else ${thread.lastMessageText} end`,
              }),
            })
            .where(eq(thread.id, threadId))
            .returning({ seq: thread.lastEventSeq, branchId: sql<string>`${branch}` })
        )[0];
        if (!next) throw new Error(`thread ${threadId} not found`);
        await tx.insert(threadEvent).values({
          id,
          threadId,
          branchId: next.branchId,
          seq: next.seq,
          type: event.type,
          actorKind: event.actor.kind,
          actorUserId: event.actor.kind === "user" ? event.actor.userId : null,
          data,
          ...(event.createdAt && { createdAt: event.createdAt }),
        });
        if (result !== undefined)
          await tx.insert(toolResult).values({ eventId: id, value: result });
      });
      const [stored] = await eventsWhere(eq(threadEvent.id, id));
      if (!stored) throw new Error(`event ${id} not found after append`);
      return stored;
    },

    // The branch's, the current one's when none is named.
    async eventsAfter(threadId, after, branchId) {
      return eventsWhere(
        and(
          eq(threadEvent.threadId, threadId),
          gt(threadEvent.seq, after),
          branchId ? ofBranch(branchId) : ofCurrent,
        ),
      );
    },

    async eventsAfterEach(froms, type) {
      if (froms.length === 0) return [];
      return eventsWhere(
        and(
          type ? eq(threadEvent.type, type) : undefined,
          or(
            ...froms.map(({ threadId, after }) =>
              and(eq(threadEvent.threadId, threadId), gt(threadEvent.seq, after)),
            ),
          ),
          ofCurrent,
        ),
      );
    },

    async eventsOfType(threadId, type) {
      return eventsWhere(
        and(eq(threadEvent.threadId, threadId), eq(threadEvent.type, type), ofCurrent),
      );
    },

    async results(eventIds) {
      const results = new Map<string, unknown>();
      if (eventIds.length === 0) return results;
      const rows = await db
        .select()
        .from(toolResult)
        .where(inArray(toolResult.eventId, [...eventIds]));
      for (const row of rows) results.set(row.eventId, row.value);
      return results;
    },

    async result(eventId) {
      return (
        (
          await db
            .select({ threadId: threadEvent.threadId, value: toolResult.value })
            .from(toolResult)
            .innerJoin(threadEvent, eq(threadEvent.id, toolResult.eventId))
            .where(eq(toolResult.eventId, eventId))
            .limit(1)
        )[0] ?? null
      );
    },
  };
}

// Where the row each restore branch picked by `branches` (as `b`) was restored from ends in its
// parent's log, as the thread's fold placed it: a person's message, or a notice that wakes the
// agent, where the run that took it in did, after what came before it there; any other row where
// the event that made it is, with all of that event's words. The migration that added the place
// runs the same statement over every restore branch.
export function restoredPlace(branches: SQL | string) {
  const where = typeof branches === "string" ? sql.raw(branches) : branches;
  return sql`
    update thread_branch b set (read_seq, read_ord) = (
      select p.seq, p.ord from (
        select a.seq, i.n * 1000 + case when m.type = 'notice' then 999 else 0 end as ord
          from thread_event m
          join thread_event a on a.thread_id = m.thread_id and a.type = 'message.admitted'
                             and a.seq <= b.fork_seq
          cross join lateral json_array_elements_text(a.data->'messageIds')
               with ordinality as i(id, n)
         where m.id = b.row_id and i.id = m.id
           and coalesce((m.data->>'quiet')::boolean, false) = false
           and coalesce((m.data->>'wake')::boolean, true)
           and exists (select 1 from thread_branch_source s
                        where s.branch_id = b.id and s.source_branch_id = a.branch_id
                          and (s.until_seq is null or a.seq <= s.until_seq))
        union all
        select e.seq, 2147483647
          from thread_event e
         where e.thread_id = b.thread_id and e.seq <= b.fork_seq
           and (e.id = b.row_id
                or (e.type = 'tool.requested' and e.data->>'callId' = b.row_id)
                or (e.type = 'message.started' and e.data->>'messageId' = b.row_id))
           and not (e.type = 'message' and coalesce((e.data->>'quiet')::boolean, false) = false)
           and not (e.type = 'notice' and coalesce((e.data->>'wake')::boolean, true))
           and exists (select 1 from thread_branch_source s
                        where s.branch_id = b.id and s.source_branch_id = e.branch_id
                          and (s.until_seq is null or e.seq <= s.until_seq))
      ) p
      order by p.seq desc
      limit 1)
     where b.kind = 'restore' and ${where}`;
}
