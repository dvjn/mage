// Rows of tool calls. Every change of where a call stands is one guarded statement through the
// call machine, answering the row it moved or nothing when the call had moved already; a job's
// running row is held by the instance running it under a lease.

import { type AnyColumn, and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";

import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Db } from "@/server/db/db.ts";
import { type Lease, leasesOn } from "@/server/sync/lease.ts";

import { call, type CallStatus, callMachine, OPEN_CALL_STATES, scriptPause } from "./schema.ts";

export type CallRow = typeof call.$inferSelect;
export type NewCallRow = Pick<
  CallRow,
  | "threadId"
  | "id"
  | "branchId"
  | "runId"
  | "toolId"
  | "risk"
  | "status"
  | "waitsFor"
  | "background"
  | "seq"
> &
  Partial<Pick<CallRow, "model" | "parentId">>;

// The right to carry out a running job, held by one server instance.
export interface CallLease extends Lease {
  threadId: string;
  callId: string;
}

const leases = leasesOn(call);

type Event = Parameters<typeof callMachine.to>[0];

export type CallStore = ReturnType<typeof createCallStore>;

// A restore the branch descends from, that left out a call requested at `seq`: one asked for after
// the restored row and before the restored branch starts. A call asked for earlier stays, however
// late it was decided.
function leftOutByRestore(branchId: SQL, seq: SQL | AnyColumn) {
  return sql`select 1 from thread_branch_source a
               join thread_branch b on b.id = a.source_branch_id
              where a.branch_id = ${branchId} and b.read_seq is not null
                and ${seq} > b.read_seq and ${seq} <= b.fork_seq`;
}

// Whether the call is a job paused at a call of its own that waits for a person.
export function pausedOn(threadId: SQL | AnyColumn, id: SQL | AnyColumn) {
  return sql`exists (select 1 from call w where w.thread_id = ${threadId} and w.parent_id = ${id}
                                         and w.status = 'waiting')`;
}

export function createCallStore(db: Db) {
  const one = (threadId: string, id: string) => and(eq(call.threadId, threadId), eq(call.id, id));

  // Moves the call by the event, setting what else is given, where it stands where the event may
  // move it from and `where` holds.
  async function move(
    threadId: string,
    id: string,
    event: Event,
    set: PgUpdateSetSource<typeof call> = {},
    where?: SQL,
  ): Promise<CallRow | null> {
    return (
      (
        await db
          .update(call)
          .set({ ...callMachine.to(event), ...set })
          .where(and(one(threadId, id), callMachine.from(event, call.status), where))
          .returning()
      )[0] ?? null
    );
  }

  const ended = () => ({ endedAt: sql`clock_timestamp()` });

  // Ends a call that may be a paused script before it ran to its end, dropping where it stood
  // with it. One that completes or fails runs first, which takes its saved state.
  async function end(...args: Parameters<typeof move>) {
    const [threadId, id] = args;
    const moved = await move(...args);
    if (moved) {
      await db
        .delete(scriptPause)
        .where(and(eq(scriptPause.threadId, threadId), eq(scriptPause.callId, id)));
    }
    return moved;
  }

  return {
    async insert(rows: (NewCallRow & { lease?: { owner: string; leaseMs: number } })[]) {
      if (rows.length === 0) return [];
      return await db
        .insert(call)
        .values(
          rows.map(({ lease, ...row }) => ({
            ...row,
            ...(row.status === "running" && {
              startedAt: sql`clock_timestamp()`,
            }),
            ...(lease && { ...leases.take(lease.owner, lease.leaseMs), leaseEpoch: 1 }),
          })),
        )
        .returning();
    },

    async find(threadId: string, id: string) {
      return (await db.select().from(call).where(one(threadId, id)).limit(1))[0] ?? null;
    },

    // The call where the thread's current branch asked for it, or on the branch's way to it.
    async onCurrent(threadId: string, id: string) {
      return (
        (
          await db
            .select()
            .from(call)
            .where(
              and(
                one(threadId, id),
                sql`exists (select 1 from thread t
                              join thread_branch_source s on s.branch_id = t.current_branch_id
                             where t.id = ${call.threadId} and s.source_branch_id = ${call.branchId}
                               and (s.until_seq is null or ${call.seq} <= s.until_seq))`,
                sql`not exists (${leftOutByRestore(sql`(select current_branch_id from thread where id = ${call.threadId})`, call.seq)})`,
              ),
            )
            .limit(1)
        )[0] ?? null
      );
    },

    // The thread's jobs, newest first.
    // The thread's jobs, newest first, each with whether it is paused at a call of its own that
    // waits for a person.
    async jobs(threadId: string) {
      const rows = await db
        .select({ row: call, paused: sql<boolean>`${pausedOn(call.threadId, call.id)}` })
        .from(call)
        .where(and(eq(call.threadId, threadId), eq(call.background, true)))
        .orderBy(desc(call.createdAt), desc(call.id));
      return rows.map(({ row, paused }) => ({ ...row, paused: row.status === "ready" && paused }));
    },

    // What a paused script had printed, where it is paused.
    async pausedPrinted(threadId: string, id: string) {
      const [row] = await db
        .select({ printed: scriptPause.printed })
        .from(scriptPause)
        .where(and(eq(scriptPause.threadId, threadId), eq(scriptPause.callId, id)));
      return row?.printed ?? null;
    },

    // How many of the thread's jobs run; those waiting for a person or for a turn hold no place.
    async runningJobs(threadId: string) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(call)
        .where(
          and(eq(call.threadId, threadId), eq(call.background, true), eq(call.status, "running")),
        );
      return rows[0]?.count ?? 0;
    },

    // Whether one of the thread's jobs stands ready, waiting for its turn to run.
    async hasReady(threadId: string) {
      const rows = await db
        .select({ id: call.id })
        .from(call)
        .where(
          and(
            eq(call.threadId, threadId),
            eq(call.background, true),
            eq(call.status, "ready"),
            sql`not ${pausedOn(call.threadId, call.id)}`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    // The run's calls that have not ended, leaving out jobs and what a job made, as the calls of
    // a script moved to the background.
    async openFor(threadId: string, runId: string) {
      return await db
        .select()
        .from(call)
        .where(
          and(
            eq(call.threadId, threadId),
            eq(call.runId, runId),
            eq(call.background, false),
            inArray(call.status, [...OPEN_CALL_STATES]),
            sql`not exists (
              with recursive up(id, parent_id, background) as (
                select p.id, p.parent_id, p.background from call p
                 where p.thread_id = ${call.threadId} and p.id = ${call.parentId}
                union all
                select p.id, p.parent_id, p.background from call p join up on p.id = up.parent_id
                 where p.thread_id = ${call.threadId})
              select 1 from up where up.background)`,
          ),
        );
    },

    // The calls of the threads that wait for a person.
    async waiting(threadIds: readonly string[]) {
      if (threadIds.length === 0) return [];
      return await db
        .select()
        .from(call)
        .where(and(inArray(call.threadId, [...threadIds]), eq(call.status, "waiting")));
    },

    // A decision or an answer: who gave it, where its event is, and for an approval its scope.
    allow: async (
      threadId: string,
      id: string,
      by: string | null,
      scope: "once" | "for_now",
      seq: number | null = null,
    ) =>
      move(threadId, id, "allow", {
        waitsFor: null,
        decidedBy: by,
        decidedAt: sql`clock_timestamp()`,
        decidedSeq: seq,
        scope,
      }),

    deny: async (threadId: string, id: string, by: string | null, seq: number | null = null) =>
      move(threadId, id, "deny", {
        waitsFor: null,
        decidedBy: by,
        decidedAt: sql`clock_timestamp()`,
        decidedSeq: seq,
        ...ended(),
      }),

    skip: async (threadId: string, id: string, by: string, seq: number) =>
      move(threadId, id, "skip", {
        waitsFor: null,
        decidedBy: by,
        decidedAt: sql`clock_timestamp()`,
        decidedSeq: seq,
        ...ended(),
      }),

    // The vouches for now the branch reads: its calls approved for now by a person, where the
    // approval is on the branch.
    async vouches(threadId: string, branchId: string) {
      const rows = await db.execute<{ id: string; tool_id: string; by: string; seq: number }>(sql`
        select c.id, c.tool_id, c.decided_by as by, c.decided_seq as seq
          from call c
          join thread_event e on e.thread_id = c.thread_id and e.seq = c.decided_seq
          join thread_branch_source s on s.branch_id = ${branchId}
                                     and s.source_branch_id = e.branch_id
                                     and (s.until_seq is null or e.seq <= s.until_seq)
         where c.thread_id = ${threadId} and c.scope = 'for_now' and c.decided_by is not null
           and c.status not in ('denied', 'skipped')
           and not exists (${leftOutByRestore(sql`${branchId}`, sql`c.seq`)})`);
      return rows.rows.map((row) => ({
        callId: row.id,
        toolId: row.tool_id,
        by: row.by,
        seq: row.seq,
      }));
    },

    start: async (threadId: string, id: string) =>
      move(threadId, id, "start", { startedAt: sql`clock_timestamp()` }),

    // Pauses a running script where its sandbox stood, to start again once the call it waits on
    // is decided.
    async pause(
      threadId: string,
      id: string,
      kept: { snapshot: Buffer; printed: string; waiting: { future: number; callId: string }[] },
    ) {
      // A job's lease goes with it, taken again by the start that resumes it.
      const paused = await move(threadId, id, "pause", leases.release());
      if (!paused) return null;
      await db.insert(scriptPause).values({ threadId, callId: id, ...kept });
      return paused;
    },

    // The calls by their ids.
    async findAll(threadId: string, ids: readonly string[]) {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(call)
        .where(and(eq(call.threadId, threadId), inArray(call.id, [...ids])));
    },

    // Where the paused script stood, taken once by the start that resumes it.
    async takePause(threadId: string, id: string) {
      return (
        (
          await db
            .delete(scriptPause)
            .where(and(eq(scriptPause.threadId, threadId), eq(scriptPause.callId, id)))
            .returning({
              snapshot: scriptPause.snapshot,
              printed: scriptPause.printed,
              waiting: scriptPause.waiting,
            })
        )[0] ?? null
      );
    },

    // Cancels every open call the calls made, and those they made in turn, in one statement; the
    // calls cancelled. Without `jobs`, a job among them, and all under it, is left to run on.
    async cancelBelow(threadId: string, ids: readonly string[], jobs: boolean) {
      if (ids.length === 0) return [];
      const kept = jobs ? sql`` : sql`and not c.background`;
      const below = sql`with recursive below(id) as (
          select c.id from call c
           where c.thread_id = ${threadId} ${kept} and c.parent_id in (${sql.join(
             ids.map((id) => sql`${id}`),
             sql`, `,
           )})
          union
          select c.id from call c join below b on c.parent_id = b.id
           where c.thread_id = ${threadId} ${kept})
        select id from below`;
      const cancelled = await db
        .update(call)
        .set({ ...callMachine.to("cancel"), waitsFor: null, ...ended(), ...leases.release() })
        .where(
          and(
            eq(call.threadId, threadId),
            sql`${call.id} in (${below})`,
            callMachine.from("cancel", call.status),
          ),
        )
        .returning();
      if (cancelled.length > 0) {
        await db.delete(scriptPause).where(
          and(
            eq(scriptPause.threadId, threadId),
            inArray(
              scriptPause.callId,
              cancelled.map((one) => one.id),
            ),
          ),
        );
      }
      return cancelled;
    },

    // Whether the call, or one that made it or made that in turn, is of the tool.
    async underOf(threadId: string, id: string, toolId: string) {
      const rows = await db.execute(sql`
        with recursive up(id, parent_id, tool_id) as (
          select c.id, c.parent_id, c.tool_id from call c
           where c.thread_id = ${threadId} and c.id = ${id}
          union all
          select c.id, c.parent_id, c.tool_id from call c join up on c.id = up.parent_id
           where c.thread_id = ${threadId})
        select 1 from up where tool_id = ${toolId} limit 1`);
      return rows.rows.length > 0;
    },

    // The calls waiting for a person that jobs paused at, with the job each is under.
    async waitingUnderJobs(threadId: string) {
      return await db
        .select()
        .from(call)
        .where(
          and(
            eq(call.threadId, threadId),
            eq(call.status, "waiting"),
            sql`exists (select 1 from call p where p.thread_id = ${call.threadId}
                           and p.id = ${call.parentId} and p.background and p.status = 'ready')`,
          ),
        );
    },

    async dropPause(threadId: string, id: string) {
      await db
        .delete(scriptPause)
        .where(and(eq(scriptPause.threadId, threadId), eq(scriptPause.callId, id)));
    },

    // How many calls the call made.
    async made(threadId: string, parentId: string) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(call)
        .where(and(eq(call.threadId, threadId), eq(call.parentId, parentId)));
      return { count: row?.count ?? 0 };
    },

    // Runs a job that waited, held by the owner; null when it no longer stands ready.
    startJob: async (threadId: string, id: string, owner: string, leaseMs: number) =>
      move(threadId, id, "start", {
        startedAt: sql`clock_timestamp()`,
        ...leases.take(owner, leaseMs),
      }),

    goStale: async (threadId: string, id: string) =>
      end(threadId, id, "goStale", { waitsFor: null, ...ended() }),

    complete: async (threadId: string, id: string) =>
      move(threadId, id, "complete", { waitsFor: null, ...ended() }),

    fail: async (threadId: string, id: string) => move(threadId, id, "fail", ended()),

    // Ends a running job under its lease, letting the lease go; null when the lease no longer
    // holds.
    finish: async (lease: CallLease, status: Extract<CallStatus, "completed" | "failed">) =>
      move(
        lease.threadId,
        lease.callId,
        status === "completed" ? "complete" : "fail",
        { ...ended(), ...leases.release() },
        leases.held(lease),
      ),

    // A running job nobody holds any more, unless another found it first.
    interrupt: async (threadId: string, id: string) =>
      end(
        threadId,
        id,
        "interrupt",
        { ...ended(), ...leases.release() },
        and(eq(call.background, true), leases.expired()),
      ),

    cancel: async (threadId: string, id: string) =>
      end(threadId, id, "cancel", { waitsFor: null, ...ended(), ...leases.release() }),

    // Asks the holder of the running call to move it to the background; null when it is not a
    // run's call running now, or a move was asked already.
    requestMove: async (threadId: string, id: string) =>
      (
        await db
          .update(call)
          .set({ moveRequestedAt: sql`clock_timestamp()` })
          .where(
            and(
              one(threadId, id),
              eq(call.status, "running"),
              eq(call.background, false),
              isNull(call.moveRequestedAt),
            ),
          )
          .returning()
      )[0] ?? null,

    // Of the running calls named, those someone asked to move.
    async moveAsked(calls: readonly { threadId: string; id: string }[]) {
      if (calls.length === 0) return [];
      return await db
        .select({ threadId: call.threadId, id: call.id })
        .from(call)
        .where(
          and(
            sql`(${call.threadId}, ${call.id}) in (${sql.join(
              calls.map((one) => sql`(${one.threadId}, ${one.id})`),
              sql`, `,
            )})`,
            eq(call.status, "running"),
            sql`${call.moveRequestedAt} is not null`,
          ),
        );
    },

    // Moves a run's call that runs or waits to the background, where it goes on as a job under the
    // same id: one running is held from then on under the lease; null when it had ended or moved.
    toBackground: async (
      threadId: string,
      id: string,
      lease?: { owner: string; leaseMs: number },
    ) =>
      (
        await db
          .update(call)
          .set({
            background: true,
            moveRequestedAt: null,
            ...(lease && leases.take(lease.owner, lease.leaseMs)),
          })
          .where(
            and(
              one(threadId, id),
              eq(call.background, false),
              inArray(call.status, lease ? ["running"] : ["waiting"]),
            ),
          )
          .returning()
      )[0] ?? null,

    // Whether the job is still held under the lease.
    async holds(lease: CallLease) {
      const rows = await db
        .select({ id: call.id })
        .from(call)
        .where(
          and(one(lease.threadId, lease.callId), eq(call.status, "running"), leases.held(lease)),
        )
        .limit(1);
      return rows.length > 0;
    },

    async renew(lease: CallLease, leaseMs: number) {
      const rows = await db
        .update(call)
        .set(leases.renew(leaseMs))
        .where(
          and(one(lease.threadId, lease.callId), eq(call.status, "running"), leases.held(lease)),
        )
        .returning({ id: call.id });
      return rows.length > 0;
    },

    async expire(lease: CallLease) {
      await db
        .update(call)
        .set(leases.expire())
        .where(
          and(one(lease.threadId, lease.callId), eq(call.status, "running"), leases.held(lease)),
        );
    },

    // Running jobs whose lease ran out.
    async stale() {
      return await db
        .select()
        .from(call)
        .where(and(eq(call.background, true), eq(call.status, "running"), leases.expired()));
    },

    // Fills the rows of the calls in the thread's log, as the log says each stands.
    async fromLog(threadId: string) {
      await db.execute(fillFromLog(sql`t.id = ${threadId}`));
    },
  };
}

// The rows of the calls in the threads' logs, as the logs say each stands: by the last event that
// settled it (ran ok or not, denied, skipped, stale, stopped); else one a branch or fork started
// afresh after is cancelled; else a run's call is cancelled once its run has ended, ready once
// approved or answered, waiting when it waits, else ready; a call moved to the background is a job
// from then on, and a job an older log made of a moved call names the call it was moved from;
// a job with nothing settling it stands as its row in the old table said, when the statement runs where that
// table is, else as a run's call does. The migration that made the table runs the same statement
// over every thread.
export function fillFromLog(threads: SQL, oldJobs = false) {
  return sql`
    with requested as (
      select distinct on (e.thread_id, e.data->>'callId')
             e.thread_id, e.data->>'callId' as id, e.branch_id, e.data->>'runId' as run_id,
             e.data->>'toolId' as tool_id, coalesce(e.data->>'risk', 'normal') as risk,
             e.data->>'within' as parent_id,
             coalesce((e.data->>'background')::boolean, false) as background,
             coalesce((e.data->>'waits')::boolean, false) as waits, e.seq, e.created_at
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type = 'tool.requested' and ${threads}
       order by e.thread_id, e.data->>'callId', e.seq
    ),
    settled as (
      select distinct on (e.thread_id, e.data->>'callId')
             e.thread_id, e.data->>'callId' as id, e.type, e.data->>'reason' as reason,
             (e.data->>'ok')::boolean as ok, e.actor_user_id, e.created_at, e.seq
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type in ('tool.ran', 'tool.denied') and ${threads}
       -- The fold takes the last result, else the first refusal.
       order by e.thread_id, e.data->>'callId', (e.type = 'tool.ran') desc,
                case when e.type = 'tool.ran' then -e.seq else e.seq end
    ),
    decided as (
      select distinct on (e.thread_id, e.data->>'callId')
             e.thread_id, e.data->>'callId' as id, e.actor_user_id, e.data->>'scope' as scope,
             e.created_at, e.seq
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type in ('tool.approved', 'tool.answered') and ${threads}
       order by e.thread_id, e.data->>'callId', e.seq
    ),
    moved as (
      select e.thread_id, e.data->>'callId' as from_id, e.data->'value'->>'callId' as id
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type = 'tool.ran' and (e.data->'value'->>'movedToBackground')::boolean is true
         and ${threads}
    ),
    moved_in_place as (
      select distinct e.thread_id, e.data->>'callId' as id
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type = 'tool.moved' and ${threads}
    ),
    ended_runs as (
      select e.thread_id, e.data->>'runId' as run_id
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type in ('run.completed', 'run.failed', 'run.cancelled') and ${threads}
    )
    insert into call (thread_id, id, branch_id, seq, run_id, tool_id, risk, status, waits_for,
                      background, model, moved_from, parent_id, lease_owner, lease_expires_at,
                      lease_epoch,
                      decided_by, decided_at, decided_seq, scope, created_at, started_at, ended_at)
    select r.thread_id, r.id, r.branch_id, r.seq, r.run_id, r.tool_id, r.risk, s.status,
           case when s.status = 'waiting'
                then case when r.tool_id = 'thread.ask' then 'answer' else 'decision' end end,
           s.background,
           (select u.model from run u where u.id = r.run_id),
           (select m.from_id from moved m where m.thread_id = r.thread_id and m.id = r.id limit 1),
           r.parent_id,
           case when s.status = 'running' then s.lease_owner end,
           case when s.status = 'running' then s.lease_expires_at end,
           coalesce(s.lease_epoch, 0),
           coalesce(d.actor_user_id, case when x.type = 'tool.denied' then x.actor_user_id end),
           coalesce(d.created_at, case when x.type = 'tool.denied' and x.actor_user_id is not null
                                       then x.created_at end),
           coalesce(d.seq, case when x.type = 'tool.denied' and x.actor_user_id is not null
                                then x.seq end),
           case when d.scope in ('once', 'for_now') then d.scope
                when d.id is not null then 'once' end,
           r.created_at,
           case when s.status in ('running', 'completed', 'failed', 'interrupted') then r.created_at end,
           case when s.status in ('ready', 'waiting', 'running') then null
                else coalesce(x.created_at, r.created_at) end
      from requested r
      left join settled x on x.thread_id = r.thread_id and x.id = r.id
      left join decided d on d.thread_id = r.thread_id and d.id = r.id
      ${oldJobs ? sql`left join background_call b on b.id = r.id and r.background` : sql``}
      cross join lateral (
        select r.background or exists (select 1 from moved_in_place p
                                        where p.thread_id = r.thread_id and p.id = r.id)
               as background
      ) g
      cross join lateral (
        select g.background,
               case
                 when x.type = 'tool.ran' and x.ok then 'completed'
                 when x.type = 'tool.ran' then 'failed'
                 when x.type = 'tool.denied' and x.reason = 'denied' then 'denied'
                 when x.type = 'tool.denied' and x.reason = 'skipped' then 'skipped'
                 when x.type = 'tool.denied' and x.reason = 'stale' then 'stale'
                 when x.type = 'tool.denied' then 'cancelled'
                 -- A branch or a fork started afresh after it stops it, as it does every open call.
                 when exists (select 1 from thread_event f
                               where f.thread_id = r.thread_id and f.branch_id = r.branch_id
                                 and f.seq > r.seq
                                 and f.type in ('branch.started', 'thread.forked')) then 'cancelled'
                 ${
                   oldJobs
                     ? sql`when r.background and b.status = 'pending' then 'waiting'
                           when r.background and b.status = 'running' then 'running'
                           when r.background and b.status = 'done' then 'completed'
                           when r.background and b.status in ('failed', 'interrupted', 'cancelled')
                                then b.status`
                     : sql``
                 }
                 when exists (select 1 from ended_runs u
                               where u.thread_id = r.thread_id and u.run_id = r.run_id)
                      and not g.background then 'cancelled'
                 when d.id is not null then 'ready'
                 when r.waits then 'waiting'
                 else 'ready'
               end as status,
               ${
                 oldJobs
                   ? sql`b.lease_owner, b.lease_expires_at, b.lease_epoch`
                   : sql`null::text as lease_owner, null::timestamptz as lease_expires_at,
                         null::integer as lease_epoch`
               }
      ) s
    on conflict do nothing`;
}
