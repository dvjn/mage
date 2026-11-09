// Lists of threads for a reader in SQL: each thread with what it holds for them, worked out from
// its current branch, its active run, the current branch's first, and how far they have seen it,
// narrowed by text and by status, most
// recently active first with ties broken by id. A run waiting on a decision shows here as paused;
// whether the reader may make the decision, which makes it waiting, is not the database's to say. A
// thread whose subagents wait on a decision may need the reader too.

import { type SQL, sql } from "drizzle-orm";

import { containing } from "@/server/db/paging.ts";

import type { ListedThread, ListWindow, Thread, ThreadListFilter } from "./service.ts";

// The newest of these events in thread `t`'s current branch, as a correlated subquery.
function newest(column: SQL, types: string[]) {
  const kinds = sql.join(
    types.map((type) => sql`${type}`),
    sql`, `,
  );
  return sql`(select ${column} from thread_event e
                join thread_branch_source s
                  on s.branch_id = t.current_branch_id and s.source_branch_id = e.branch_id
                 and (s.until_seq is null or e.seq <= s.until_seq)
               where e.thread_id = t.id and e.type in (${kinds})
               order by e.seq desc limit 1)`;
}

// The events a reader is told about: a person's message, a finished reply and a failed run.
const NOTABLE = ["message", "message.completed", "run.failed"];

// The threads `t` of `from` that `where` keeps, with any more `columns`, and what each holds for the
// reader, as the common table `statused`.
export function statused(
  reader: string,
  { from, where, columns = sql`` }: { from: SQL; where: SQL; columns?: SQL },
) {
  return sql`
    with listed as (
      select t.id, t.space_id, t.title, t.title_source, t.model, t.effort,
             t.created_by, t.parent_thread_id, t.root_thread_id, t.current_branch_id,
             t.last_event_seq, t.created_at, t.updated_at, t.last_message_text,
             (select r.status from run r
               where r.thread_id = t.id and r.status in ('queued', 'running', 'waiting')
               order by r.branch_id = t.current_branch_id desc limit 1) as run_status,
             coalesce(tr.last_seen_seq, 0) as seen,
             ${newest(sql`e.seq`, ["run.failed"])} as failed_seq,
             ${newest(sql`e.seq`, ["run.created"])} as created_seq,
             ${newest(sql`e.seq`, NOTABLE)} as notable_seq,
             ${newest(sql`e.actor_user_id`, NOTABLE)} as notable_by,
             exists (select 1 from thread c
                       join run hr on hr.thread_id = c.id and hr.status = 'waiting'
                      where c.parent_thread_id = t.id) as subagent_waiting
             ${columns}
        ${from}
        left join thread_read tr on tr.user_id = ${reader} and tr.thread_id = t.id
       where ${where}
    ),
    statused as (
      select *,
             case
               when failed_seq > coalesce(created_seq, 0) and failed_seq > seen then 'failed'
               when run_status = 'waiting' then 'paused'
               when run_status is not null then 'working'
               when notable_seq > seen and (notable_by is null or notable_by <> ${reader})
                 then 'unread'
               else 'read'
             end as status
        from listed
    )`;
}

// The rows of `statused` the filter keeps, matching its text in any of `fields`.
export function kept(filter: ThreadListFilter, ...fields: SQL[]) {
  const show =
    filter.show === "unread"
      ? sql`status = 'unread'`
      : filter.show === "maybe-needs-you"
        ? sql`(status = 'failed' or run_status = 'waiting' or subagent_waiting)`
        : sql`1 = 1`;
  return sql`${show} and ${containing(filter.text, ...fields)}`;
}

export const newestFirst = sql`order by updated_at desc, id desc`;

export function windowOf(window: ListWindow | undefined) {
  return window ? sql`limit ${window.limit} offset ${window.offset}` : sql``;
}

// A row of `statused` as the thread it lists.
export interface StatusedRow {
  id: string;
  space_id: string;
  title: string | null;
  title_source: Thread["titleSource"];
  model: string | null;
  effort: Thread["effort"];
  created_by: string | null;
  parent_thread_id: string | null;
  root_thread_id: string | null;
  current_branch_id: string | null;
  last_event_seq: number;
  created_at: number;
  updated_at: number;
  run_status: string | null;
  subagent_waiting: number;
  status: string;
}

export function listedThread(row: StatusedRow): ListedThread {
  return {
    thread: {
      id: row.id,
      spaceId: row.space_id,
      title: row.title,
      titleSource: row.title_source,
      model: row.model,
      effort: row.effort,
      createdBy: row.created_by,
      parentThreadId: row.parent_thread_id,
      rootThreadId: row.root_thread_id,
      currentBranchId: row.current_branch_id ?? row.id,
      lastEventSeq: row.last_event_seq,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    },
    waiting: row.run_status === "waiting" || !!row.subagent_waiting,
    failed: row.status === "failed",
  };
}
