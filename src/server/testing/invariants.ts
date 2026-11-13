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
    // A run queued behind one that was stopped may be there a moment before it is stopped too;
    // nothing checks the space as a run ends.
    rule: "a run running in a space in trash has been asked to stop",
    broken: sql`
      select r.id as run_id, r.thread_id, r.status
        from run r
        join thread t on t.id = r.thread_id
        join space s on s.id = t.space_id
       where r.status = 'running'
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
];

// The rules the database breaks now; none when it is sound.
export function invariants(db: Db): Violation[] {
  const violations: Violation[] = [];
  for (const { rule, broken } of RULES) {
    const rows = db.all(sql`${broken} limit 5`);
    if (rows.length > 0) violations.push({ rule, rows });
  }
  return violations;
}
