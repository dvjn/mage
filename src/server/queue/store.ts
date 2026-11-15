// Rows of the inputs for threads' agents, each where it stands on a branch. Each change of where an
// input stands is one guarded statement through the input machine, on the branch named: zero rows
// changed means it had moved already.

import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";
import { run } from "@/server/execution/schema.ts";
import { subagent } from "@/server/subagents/schema.ts";
import { user } from "@/server/orgs/schema.ts";
import { thread, threadBranchSource } from "@/server/threads/schema.ts";

import { inputMachine, threadInput, threadWord } from "./schema.ts";

export type InputRow = typeof threadInput.$inferSelect;
export type NewInputRow = Omit<
  InputRow,
  "status" | "admittedRunId" | "createdAt" | "copyOf" | "sourceCallId"
> &
  Partial<Pick<InputRow, "copyOf" | "sourceCallId">>;

const ACTIVE = ["queued", "running", "waiting"] as const;

// The thread's current branch, as SQL.
const currentOf = (threadId: string) =>
  sql`(select ${thread.currentBranchId} from ${thread} where ${thread.id} = ${threadId})`;

// An input that starts the agent: a person's message, or a notice that wakes it.
const waking = sql`(${threadInput.kind} = 'message' or ${threadInput.wake})`;

export type QueueStore = ReturnType<typeof createQueueStore>;

export function createQueueStore(db: Db) {
  const waitingOn = (threadId: string, branchId?: string) =>
    and(
      eq(threadInput.threadId, threadId),
      eq(threadInput.branchId, branchId ?? currentOf(threadId)),
      eq(threadInput.status, "waiting"),
    );
  const on = (ids: readonly string[], branchId: string) =>
    and(inArray(threadInput.id, [...ids]), eq(threadInput.branchId, branchId));

  return {
    async insert(row: NewInputRow) {
      return (
        await db
          .insert(threadInput)
          .values({ ...row, status: "waiting" })
          .returning()
      )[0]!;
    },

    async find(id: string, branchId: string) {
      return (
        (
          await db
            .select()
            .from(threadInput)
            .where(on([id], branchId))
            .limit(1)
        )[0] ?? null
      );
    },

    async byKey(threadId: string, key: string) {
      return (
        (
          await db
            .select()
            .from(threadInput)
            .where(and(eq(threadInput.threadId, threadId), eq(threadInput.key, key)))
            .limit(1)
        )[0] ?? null
      );
    },

    // Oldest first.
    async waiting(threadId: string, branchId?: string) {
      return await db
        .select()
        .from(threadInput)
        .where(waitingOn(threadId, branchId))
        .orderBy(asc(threadInput.seq));
    },

    // Whether a person's message waits on the branch.
    async messageWaits(threadId: string, branchId?: string) {
      const found = await db
        .select({ id: threadInput.id })
        .from(threadInput)
        .where(and(waitingOn(threadId, branchId), eq(threadInput.kind, "message")))
        .limit(1);
      return found.length > 0;
    },

    // Whether an input that starts the agent waits on the branch.
    async wakes(threadId: string, branchId?: string) {
      const found = await db
        .select({ id: threadInput.id })
        .from(threadInput)
        .where(and(waitingOn(threadId, branchId), waking))
        .limit(1);
      return found.length > 0;
    },

    // Threads with an input that starts the agent waiting on their current branch and no run under
    // way there; not a log copied in with no runs of its own, which waits for whatever starts it
    // next, nor a retired subagent's. A subagent's thread held back before its first run counts.
    async stranded() {
      const rows = await db
        .selectDistinct({ threadId: threadInput.threadId })
        .from(threadInput)
        .innerJoin(thread, eq(thread.id, threadInput.threadId))
        .where(
          and(
            eq(threadInput.status, "waiting"),
            eq(threadInput.branchId, thread.currentBranchId),
            waking,
            sql`(${thread.rootThreadId} is not null
                 or exists (select 1 from ${run} where ${run.threadId} = ${thread.id}))`,
            sql`not exists (select 1 from ${subagent} where ${subagent.threadId} = ${thread.id}
                             and ${subagent.archivedAt} is not null)`,
            sql`not exists (select 1 from ${run} where ${run.branchId} = ${thread.currentBranchId}
                             and ${run.status} in ${sql.raw(`(${ACTIVE.map((s) => `'${s}'`).join(", ")})`)})`,
          ),
        )
        .orderBy(asc(threadInput.threadId));
      return rows.map((row) => row.threadId);
    },

    async admit(ids: readonly string[], runId: string, branchId: string) {
      if (ids.length === 0) return [];
      return await db
        .update(threadInput)
        .set({ ...inputMachine.to("admit"), admittedRunId: runId })
        .where(and(on(ids, branchId), inputMachine.from("admit", threadInput.status)))
        .returning();
    },

    // Records on the branch that its run took in again inputs an earlier run took in elsewhere.
    async readmit(threadId: string, ids: readonly string[], runId: string, branchId: string) {
      if (ids.length === 0) return;
      await db.execute(sql`
        insert into ${threadInput} (id, thread_id, branch_id, seq, kind, status, wake, delivery,
                                    author_id, origin_kind, origin_id, admitted_run_id,
                                    source_call_id)
        select distinct on (i.id) i.id, i.thread_id, ${branchId}, i.seq, i.kind, 'admitted',
               i.wake, i.delivery, i.author_id, i.origin_kind, i.origin_id, ${runId},
               i.source_call_id
          from ${threadInput} i
         where i.thread_id = ${threadId} and i.id in ${sql`(${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})`}
         order by i.id, (i.status = 'admitted') desc
        on conflict (id, branch_id)
        do update set status = 'admitted', admitted_run_id = excluded.admitted_run_id`);
    },

    async withdraw(id: string, branchId: string) {
      return (
        (
          await db
            .update(threadInput)
            .set(inputMachine.to("withdraw"))
            .where(and(on([id], branchId), inputMachine.from("withdraw", threadInput.status)))
            .returning()
        )[0] ?? null
      );
    },

    async drop(ids: readonly string[], branchId: string) {
      if (ids.length === 0) return [];
      return await db
        .update(threadInput)
        .set(inputMachine.to("drop"))
        .where(and(on(ids, branchId), inputMachine.from("drop", threadInput.status)))
        .returning();
    },

    // A waiting message steers or waits for the next run.
    async setDelivery(id: string, branchId: string, delivery: "steer" | "queue") {
      await db
        .update(threadInput)
        .set({ delivery })
        .where(and(on([id], branchId), eq(threadInput.status, "waiting")));
    },

    // A row waiting on the thread's current branch for each notice it reads that no admission it
    // reads names.
    async fillCurrent(threadId: string) {
      await db.execute(waitingOnCurrent(sql`t.id = ${threadId}`));
    },

    // The notices waiting on the branch left that the new branch does not read, and that it is
    // told: those no call sent, and those whose call it holds.
    async carried(threadId: string, left: string, branchId: string) {
      const rows = await db.execute<{ id: string }>(sql`
        select i.id
          from ${threadInput} i
          join thread_event e on e.thread_id = i.thread_id and e.id = i.id
         where i.thread_id = ${threadId} and i.branch_id = ${left}
           and i.status = 'waiting' and i.kind = 'notice'
           and not exists (select 1 from thread_branch_source s
                            where s.branch_id = ${branchId} and s.source_branch_id = e.branch_id
                              and (s.until_seq is null or e.seq <= s.until_seq))
           and (i.source_call_id is null or exists (
                  select 1 from call c
                    join thread_branch_source s on s.branch_id = ${branchId}
                                               and s.source_branch_id = c.branch_id
                                               and (s.until_seq is null or c.seq <= s.until_seq)
                   where c.thread_id = i.thread_id and c.id = i.source_call_id))
         order by i.seq`);
      const ids = rows.rows.map((row) => row.id);
      if (ids.length === 0) return [];
      return await db.select().from(threadInput).where(on(ids, left)).orderBy(asc(threadInput.seq));
    },

    // What came to the thread from the origin, each once however many branches hold it, copies
    // left out, newest first: a page of it, and how many there are in all.
    async history(
      threadId: string,
      origin: { kind: InputRow["originKind"]; id: string },
      page: { offset: number; limit: number },
    ) {
      const from = and(
        eq(threadInput.threadId, threadId),
        eq(threadInput.originKind, origin.kind),
        eq(threadInput.originId, origin.id),
        isNull(threadInput.copyOf),
      );
      const [counted] = await db
        .select({ total: sql<number>`count(distinct ${threadInput.id})::int` })
        .from(threadInput)
        .where(from);
      const rows = await db
        .selectDistinctOn([threadInput.seq, threadInput.id])
        .from(threadInput)
        .where(from)
        .orderBy(desc(threadInput.seq), threadInput.id)
        .limit(page.limit)
        .offset(page.offset);
      return { total: counted?.total ?? 0, rows };
    },

    // How many inputs came to the thread from each origin of the kinds, each once.
    async counts(threadId: string, kinds: readonly InputRow["originKind"][]) {
      if (kinds.length === 0) return new Map<string, number>();
      const rows = await db
        .select({
          originId: threadInput.originId,
          count: sql<number>`count(distinct ${threadInput.id})::int`,
        })
        .from(threadInput)
        .where(
          and(
            eq(threadInput.threadId, threadId),
            inArray(threadInput.originKind, [...kinds]),
            isNull(threadInput.copyOf),
          ),
        )
        .groupBy(threadInput.originId);
      return new Map(rows.map((row) => [row.originId, row.count]));
    },

    // Records whose words the events at the seqs put before the thread's agent.
    async spoke(threadId: string, seqs: readonly number[]) {
      if (seqs.length === 0) return;
      await db.execute(
        wordsFromLog(
          sql`e.thread_id = ${threadId} and e.seq in (${sql.join(
            seqs.map((seq) => sql`${seq}`),
            sql`, `,
          )})`,
        ),
      );
    },

    // Whose words the branch's agent read, oldest first, each with the name it carries, or the
    // person's name now.
    async words(threadId: string, branchId?: string) {
      return await db
        .select({
          seq: threadWord.seq,
          userId: threadWord.userId,
          name: sql<string | null>`coalesce(${threadWord.name}, ${user.name})`,
          via: threadWord.via,
        })
        .from(threadWord)
        .innerJoin(
          threadBranchSource,
          and(
            eq(threadBranchSource.branchId, branchId ?? currentOf(threadId)),
            eq(threadBranchSource.sourceBranchId, threadWord.branchId),
            sql`(${threadBranchSource.untilSeq} is null or ${threadWord.seq} <= ${threadBranchSource.untilSeq})`,
          ),
        )
        .leftJoin(user, eq(user.id, threadWord.userId))
        .where(
          and(
            eq(threadWord.threadId, threadId),
            // Not what a restore it descends from left out: what came after the restored row up to
            // where the branch starts, but answers to the calls it keeps.
            sql`not exists (
              select 1 from thread_branch_source a
                join thread_branch b on b.id = a.source_branch_id
               where a.branch_id = ${threadBranchSource.branchId} and b.read_seq is not null
                 and ${threadWord.seq} <= b.fork_seq
                 and (${threadWord.seq}, ${threadWord.ord}) > (b.read_seq, b.read_ord)
                 and (${threadWord.callSeq} is null or ${threadWord.callSeq} > b.read_seq))`,
          ),
        )
        .orderBy(asc(threadWord.seq), asc(threadWord.ord));
    },

    // Fills the rows of the thread's inputs, and whose words it read, from its log, as the log
    // says each stands.
    async fromLog(threadId: string) {
      await db.execute(fillFromLog(sql`t.id = ${threadId}`));
      await db.execute(wordsFromLog(sql`e.thread_id = ${threadId}`));
    },
  };
}

// The rows of the inputs in the threads' logs, as the logs say each stands: taken in by the run
// that last named it, taken back or dropped by their events, else waiting where the thread's
// current branch still reads it (a person's message only on that branch itself, and not once a
// fork or a branch started afresh after it), else dropped.
// Where each came from is read from the event. The migration that made the table runs the same
// statement over every thread.
export function fillFromLog(threads: SQL | string) {
  const where = typeof threads === "string" ? sql.raw(threads) : threads;
  return sql`
    with recursive lineage (thread_id, branch_id, upto) as (
      select t.id, t.current_branch_id, null::integer from thread t where ${where}
      union all
      select l.thread_id, b.parent_branch_id, least(coalesce(l.upto, b.fork_seq), b.fork_seq)
        from lineage l join thread_branch b on b.id = l.branch_id
       where b.parent_branch_id is not null
    ),
    admitted as (
      select distinct on (m.id) m.id, e.data->>'runId' as run_id
        from thread_event e
        join thread t on t.id = e.thread_id
        cross join lateral json_array_elements_text(e.data->'messageIds') as m(id)
       where e.type = 'message.admitted' and ${where}
       order by m.id, e.seq desc
    ),
    ended as (
      select e.data->>'messageId' as id, max(e.type) as type
        from thread_event e
        join thread t on t.id = e.thread_id
       where e.type in ('message.withdrawn', 'message.dropped') and ${where}
       group by e.data->>'messageId'
    )
    insert into thread_input (id, thread_id, branch_id, seq, kind, status, wake, delivery,
                              author_id, origin_kind, origin_id, key, admitted_run_id, created_at)
    select e.id, e.thread_id,
           -- A notice still read where it waits now goes to the current branch.
           case when st.status = 'waiting' then t.current_branch_id else e.branch_id end,
           e.seq,
           case when e.type = 'message' then 'message' else 'notice' end,
           st.status,
           e.type = 'message' or coalesce((e.data->>'wake')::boolean, true),
           case when e.type = 'message' then coalesce(e.data->>'mode', 'steer') end,
           case when e.type = 'message' then e.actor_user_id end,
           case when e.type = 'message' then 'person'
                when e.data->>'kind' = 'schedule.fired' and e.data->>'scheduleId' is not null then 'schedule'
                when e.data->>'kind' = 'webhook.received' and e.data->>'webhookId' is not null then 'webhook'
                when e.data->>'kind' = 'call.ended' and e.data->'source'->>'callId' is not null then 'job'
                when e.data->'actor'->>'kind' = 'person' then 'person'
                when e.data->'source'->>'threadId' <> e.thread_id then 'subagent'
                else 'system' end,
           case when e.type = 'message' then e.actor_user_id
                when e.data->>'kind' = 'schedule.fired' and e.data->>'scheduleId' is not null
                     then e.data->>'scheduleId'
                when e.data->>'kind' = 'webhook.received' and e.data->>'webhookId' is not null
                     then e.data->>'webhookId'
                when e.data->>'kind' = 'call.ended' and e.data->'source'->>'callId' is not null
                     then e.data->'source'->>'callId'
                when e.data->'actor'->>'kind' = 'person' then e.data->'actor'->>'userId'
                when e.data->'source'->>'threadId' <> e.thread_id then e.data->'source'->>'threadId'
                else e.thread_id end,
           null,
           a.run_id,
           e.created_at
      from thread_event e
      join thread t on t.id = e.thread_id
      left join admitted a on a.id = e.id
      left join ended x on x.id = e.id
      cross join lateral (
        select case when a.id is not null then 'admitted'
                when x.type = 'message.withdrawn' then 'withdrawn'
                when x.type = 'message.dropped' then 'dropped'
                when e.type = 'message' and e.branch_id = t.current_branch_id and not exists (
                  select 1 from thread_event f
                   where f.thread_id = e.thread_id and f.branch_id = e.branch_id and f.seq > e.seq
                     and f.type in ('thread.forked', 'branch.started'))
                     then 'waiting'
                when e.type = 'notice' and exists (
                  select 1 from lineage l
                   where l.thread_id = e.thread_id and l.branch_id = e.branch_id
                     and (l.upto is null or e.seq <= l.upto)) then 'waiting'
                else 'dropped' end as status
      ) st
     where ${where}
       and (e.type = 'notice'
            or (e.type = 'message' and e.actor_kind = 'user' and e.actor_user_id is not null
                and coalesce((e.data->>'quiet')::boolean, false) = false))
    on conflict do nothing`;
}

// A row waiting on each thread's current branch for every notice the branch reads that no
// admission it reads names, as the branch's fold has it waiting; it repeats where the notice came
// from and what sent it.
export function waitingOnCurrent(threads: SQL | string) {
  const where = typeof threads === "string" ? sql.raw(threads) : threads;
  return sql`
    insert into thread_input (id, thread_id, branch_id, seq, kind, status, wake, origin_kind,
                              origin_id, created_at, copy_of, source_call_id)
    select distinct on (e.id) e.id, e.thread_id, t.current_branch_id, e.seq, 'notice', 'waiting',
           i.wake, i.origin_kind, i.origin_id, i.created_at, i.copy_of, i.source_call_id
      from thread t
      join thread_branch_source s on s.branch_id = t.current_branch_id
      join thread_event e on e.thread_id = t.id and e.branch_id = s.source_branch_id
                         and (s.until_seq is null or e.seq <= s.until_seq)
      join thread_input i on i.thread_id = e.thread_id and i.id = e.id
     where ${where} and e.type = 'notice'
       and not exists (
         select 1
           from thread_branch_source r
           join thread_event a on a.thread_id = t.id and a.branch_id = r.source_branch_id
                              and (r.until_seq is null or a.seq <= r.until_seq)
          where r.branch_id = t.current_branch_id and a.type = 'message.admitted'
            and exists (select 1 from json_array_elements_text(a.data->'messageIds') as m(id)
                         where m.id = e.id))
     order by e.id, (i.branch_id = t.current_branch_id) desc
    on conflict do nothing`;
}

// Whose words the events picked by `events` (as `e`) put before their thread's agent, in the order
// the model read them: for a run taking inputs in, each person's message's author and each waking
// notice's people; for an aside, its author where it was sent; for an answer, who gave it; for a
// notice that does not wake the agent, its people where it was told, since it is shown at once.
// The migration that made the table runs the same statement over every thread.
export function wordsFromLog(events: SQL | string) {
  const where = typeof events === "string" ? sql.raw(events) : events;
  return sql`
    insert into thread_word (thread_id, branch_id, seq, ord, user_id, name, via, call_seq)
    select e.thread_id, e.branch_id, e.seq, w.ord, w.user_id, w.name, w.via,
           case when e.type = 'tool.answered' then (
             select r.seq from thread_event r
              where r.thread_id = e.thread_id and r.type = 'tool.requested'
                and r.data->>'callId' = e.data->>'callId'
              order by r.seq limit 1) end
      from thread_event e
      cross join lateral (
        select i.n * 1000 as ord, m.actor_user_id as user_id, null::text as name,
               '[]'::jsonb as via
          from json_array_elements_text(case when e.type = 'message.admitted'
                                             then e.data->'messageIds' else '[]'::json end)
               with ordinality as i(id, n)
          join thread_event m on m.id = i.id and m.type = 'message' and m.actor_kind = 'user'
                             and m.actor_user_id is not null
        union all
        select i.n * 1000 + p.k, p.v->>'userId', p.v->>'name', (p.v->'via')::jsonb
          from json_array_elements_text(case when e.type = 'message.admitted'
                                             then e.data->'messageIds' else '[]'::json end)
               with ordinality as i(id, n)
          join thread_event m on m.id = i.id and m.type = 'notice'
                             and (coalesce((m.data->>'wake')::boolean, true)
                                  -- one that does not wake, whose row a restore left out
                                  or exists (
                                    select 1 from thread_branch_source s
                                      join thread_branch b on b.id = s.source_branch_id
                                     where s.branch_id = e.branch_id and b.read_seq is not null
                                       and m.seq > b.read_seq and m.seq <= b.fork_seq))
          cross join lateral json_array_elements(coalesce(m.data->'influence', '[]'::json))
               with ordinality as p(v, k)
        union all
        select 0, e.actor_user_id, null, '[]'::jsonb
         where e.actor_kind = 'user' and e.actor_user_id is not null
           and ((e.type = 'message' and coalesce((e.data->>'quiet')::boolean, false))
                or (e.type = 'tool.answered' and e.data->'answers' is not null
                    -- the first word on the call; the fold takes no other
                    and not exists (
                      select 1 from thread_event f
                       where f.thread_id = e.thread_id and f.seq < e.seq
                         and f.type in ('tool.answered', 'tool.approved', 'tool.denied', 'tool.ran')
                         and f.data->>'callId' = e.data->>'callId')))
        union all
        select p.k, p.v->>'userId', p.v->>'name', (p.v->'via')::jsonb
          from json_array_elements(case when e.type = 'notice'
                                             and (e.data->>'wake')::boolean is false
                                        then coalesce(e.data->'influence', '[]'::json)
                                        else '[]'::json end)
               with ordinality as p(v, k)
      ) w
     where e.type in ('message.admitted', 'message', 'tool.answered', 'notice')
       and ${where}
    on conflict do nothing`;
}
