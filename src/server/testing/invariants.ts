// What must hold in the database whatever the server was doing when it is read: rules no
// constraint states, checked after tests and browser journeys, and after data is copied in.
// Each system adds the rules of its own tables here as it gets them.

import { sql } from "drizzle-orm";

import type { Db } from "@/server/db/db.ts";

export interface Violation {
  rule: string;
  // The rows that break it, a few at most.
  rows: unknown[];
}

const RULES: { rule: string; broken: ReturnType<typeof sql> }[] = [
  {
    rule: "a thread's current branch is one of its branches",
    broken: sql`
      select t.id as thread_id, t.current_branch_id
        from thread t
        left join thread_branch b on b.id = t.current_branch_id and b.thread_id = t.id
       where b.id is null`,
  },
  {
    rule: "a thread's last event seq is the newest seq in its log",
    broken: sql`
      select t.id as thread_id, t.last_event_seq, max(e.seq) as newest
        from thread t
        left join thread_event e on e.thread_id = t.id
       group by t.id
      having t.last_event_seq <> coalesce(max(e.seq), 0)`,
  },
  {
    rule: "a thread's events are numbered from 1 with no gaps",
    broken: sql`
      select thread_id, count(*) as events, min(seq) as first, max(seq) as last
        from thread_event
       group by thread_id
      having min(seq) <> 1 or max(seq) <> count(*)`,
  },
  {
    rule: "an event's branch is one of its thread's",
    broken: sql`
      select e.id as event_id, e.thread_id, e.branch_id
        from thread_event e
        left join thread_branch b on b.id = e.branch_id and b.thread_id = e.thread_id
       where b.id is null`,
  },
  {
    rule: "a branch has at most one run under way",
    broken: sql`
      select branch_id, count(*) as runs
        from run
       where status in ('queued', 'running', 'waiting')
       group by branch_id
      having count(*) > 1`,
  },
  {
    // Only a run still queued is let off: the one made as another ended, which nothing checks
    // the space for until it is taken up.
    rule: "a run running or waiting in a space in trash has been asked to stop",
    broken: sql`
      select r.id as run_id, r.thread_id, r.status
        from run r
        join thread t on t.id = r.thread_id
        join space s on s.id = t.space_id
       where r.status in ('running', 'waiting')
         and s.trashed_at is not null
         and r.cancel_requested_at is null`,
  },
  {
    rule: "a run's branch is one of its thread's",
    broken: sql`
      select r.id as run_id, r.thread_id, r.branch_id
        from run r
        left join thread_branch b on b.id = r.branch_id and b.thread_id = r.thread_id
       where b.id is null`,
  },
  {
    rule: "every notice and every message that is not an aside has its input, and every input its event",
    broken: sql`
      select e.id as event_id, e.thread_id, e.seq, i.id as input_id
        from thread_event e
        full join thread_input i on i.id = e.id
       where (i.id is null
              and (e.type = 'notice'
                   or (e.type = 'message' and coalesce((e.data->>'quiet')::boolean, false) = false)))
          or (i.id is not null and (e.id is null or e.thread_id <> i.thread_id or e.seq <> i.seq))`,
  },
  {
    rule: "a message waits only on its thread's current branch",
    broken: sql`
      select i.id as input_id, i.thread_id, i.branch_id
        from thread_input i
        join thread t on t.id = i.thread_id
       where i.kind = 'message' and i.status = 'waiting' and i.branch_id <> t.current_branch_id`,
  },
  {
    rule: "a message has one row, but where an edit's run took it in again",
    broken: sql`
      select i.id as input_id, count(*) as rows
        from thread_input i
       where i.kind = 'message'
       group by i.id
      having count(*) > 1 and count(*) filter (where i.status <> 'admitted') > 0`,
  },
  {
    rule: "every input of a notice is on a branch that reads its event",
    broken: sql`
      select i.id as input_id, i.branch_id
        from thread_input i
        join thread_event e on e.thread_id = i.thread_id and e.id = i.id
       where i.kind = 'notice'
         and not exists (select 1 from thread_branch_source s
                          where s.branch_id = i.branch_id and s.source_branch_id = e.branch_id
                            and (s.until_seq is null or e.seq <= s.until_seq))`,
  },
  {
    rule: "a notice's source names a call of its thread",
    broken: sql`
      select i.id as input_id, i.source_call_id
        from thread_input i
        left join call c on c.thread_id = i.thread_id and c.id = i.source_call_id
       where i.source_call_id is not null and c.id is null`,
  },
  {
    // A log copied in with no runs of its own names inputs that woke runs it never had.
    rule: "every input from a schedule or webhook of its own thread has that row",
    broken: sql`
      select i.id as input_id, i.origin_kind, i.origin_id
        from thread_input i
       where i.copy_of is null
         and exists (select 1 from run r where r.thread_id = i.thread_id)
         and ((i.origin_kind = 'schedule'
               and not exists (select 1 from schedule s where s.id = i.origin_id)
               and exists (select 1 from thread_event e where e.thread_id = i.thread_id
                            and e.id = i.id and e.data->'source'->>'threadId' = i.thread_id))
           or (i.origin_kind = 'webhook'
               and not exists (select 1 from webhook w where w.id = i.origin_id)
               and exists (select 1 from thread_event e where e.thread_id = i.thread_id
                            and e.id = i.id and e.data->'source'->>'threadId' = i.thread_id)))`,
  },
  {
    rule: "a schedule's or webhook's call names a call of its thread",
    broken: sql`
      select x.id, x.thread_id, x.call_id
        from (select id, thread_id, call_id from schedule
              union all select id, thread_id, call_id from webhook) x
        left join call c on c.thread_id = x.thread_id and c.id = x.call_id
       where x.call_id is not null and c.id is null`,
  },
  {
    rule: "every call's seq is its request in its thread's log",
    broken: sql`
      select c.thread_id, c.id, c.seq
        from call c
        left join thread_event e on e.thread_id = c.thread_id and e.seq = c.seq
       where e.id is null or e.type <> 'tool.requested' or e.data->>'callId' <> c.id`,
  },
  {
    // A subagent past its starter's running limit, or retired, waits for its gate; a log copied
    // in with no runs of its own waits for whatever starts it next.
    rule: "a thread with something waiting to start its agent has a run under way, or is a subagent's",
    broken: sql`
      select distinct i.thread_id
        from thread_input i
        join thread t on t.id = i.thread_id
       where i.status = 'waiting' and i.branch_id = t.current_branch_id
         and (i.kind = 'message' or i.wake)
         and t.root_thread_id is null
         and exists (select 1 from run r where r.thread_id = t.id)
         and not exists (select 1 from run r
                          where r.branch_id = t.current_branch_id
                            and r.status in ('queued', 'running', 'waiting'))`,
  },
  {
    rule: "every tool call asked for has its row, and every row its request",
    broken: sql`
      select e.thread_id, e.data->>'callId' as call_id, c.thread_id as row_thread, c.id as row_id
        from (select * from thread_event where type = 'tool.requested') e
        full join call c on c.thread_id = e.thread_id and c.id = e.data->>'callId'
       where e.id is null or c.id is null`,
  },
  {
    rule: "a job moved from a call names a call of its thread",
    broken: sql`
      select j.thread_id, j.id, j.moved_from
        from call j
        left join call c on c.thread_id = j.thread_id and c.id = j.moved_from
       where j.moved_from is not null and (c.id is null or not j.background)`,
  },
  {
    rule: "a call moved to the background is a job, asked for once",
    broken: sql`
      select c.thread_id, c.id, c.background,
             (select count(*) from thread_event r
               where r.thread_id = c.thread_id and r.type = 'tool.requested'
                 and r.data->>'callId' = c.id) as requests
        from call c
       where exists (select 1 from thread_event m
                      where m.thread_id = c.thread_id and m.type = 'tool.moved'
                        and m.data->>'callId' = c.id)
         and (not c.background
              or (select count(*) from thread_event r
                   where r.thread_id = c.thread_id and r.type = 'tool.requested'
                     and r.data->>'callId' = c.id) <> 1)`,
  },
  {
    rule: "no call of a run that ended is left ready, waiting or running",
    broken: sql`
      select c.thread_id, c.id, c.status, r.status as run_status
        from call c
        join run r on r.id = c.run_id
       where not c.background
         and c.status in ('ready', 'waiting', 'running')
         and r.status in ('completed', 'failed', 'cancelled')`,
  },
  {
    rule: "a run that waits has a call of its own that waits",
    broken: sql`
      select r.id as run_id, r.thread_id
        from run r
       where r.status = 'waiting'
         and not exists (select 1 from call c
                          where c.run_id = r.id and not c.background and c.status = 'waiting')`,
  },
  {
    rule: "every run that ended has its end in its thread's log",
    broken: sql`
      select r.id as run_id, r.thread_id, r.status
        from run r
       where r.status in ('completed', 'failed', 'cancelled')
         and not exists (select 1 from thread_event e
                          where e.thread_id = r.thread_id
                            and e.type in ('run.completed', 'run.failed', 'run.cancelled')
                            and e.data->>'runId' = r.id)`,
  },
  {
    rule: "a thread that works on another's task list is a subagent of that thread",
    broken: sql`
      select t.thread_id, t.owner_thread_id
        from task_share t
       where not exists (select 1 from subagent s
                          where s.thread_id = t.thread_id
                            and s.parent_thread_id = t.owner_thread_id)`,
  },
  {
    rule: "an input is taken in at most once on a branch",
    broken: sql`
      select e.thread_id, e.branch_id, m.id as input_id, count(*) as times
        from thread_event e
        cross join lateral json_array_elements_text(e.data->'messageIds') as m(id)
       where e.type = 'message.admitted'
       group by e.thread_id, e.branch_id, m.id
      having count(*) > 1`,
  },
  {
    rule: "a call runs at most once",
    broken: sql`
      select thread_id, data->>'callId' as call_id, count(*) as times
        from thread_event
       where type = 'tool.ran'
       group by thread_id, data->>'callId'
      having count(*) > 1`,
  },
  {
    rule: "a run ends at most once",
    broken: sql`
      select thread_id, data->>'runId' as run_id, count(*) as times
        from thread_event
       where type in ('run.completed', 'run.failed', 'run.cancelled')
       group by thread_id, data->>'runId'
      having count(*) > 1`,
  },
  {
    rule: "a job's end is told at most once on a branch",
    broken: sql`
      select thread_id, branch_id, data->'source'->>'callId' as call_id, count(*) as times
        from thread_event
       where type = 'notice' and data->>'kind' = 'call.ended'
       group by thread_id, branch_id, data->'source'->>'callId'
      having count(*) > 1`,
  },
  {
    rule: "a key makes at most one input on a branch",
    broken: sql`
      select thread_id, branch_id, key, count(*) as times
        from thread_input
       where key is not null
       group by thread_id, branch_id, key
      having count(*) > 1`,
  },
];

// The rules the database breaks now; none when it is sound.
export async function invariants(db: Db): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const { rule, broken } of RULES) {
    const rows = (await db.execute(sql`${broken} limit 5`)).rows;
    if (rows.length > 0) violations.push({ rule, rows });
  }
  return violations;
}
