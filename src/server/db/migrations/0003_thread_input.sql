CREATE TABLE "thread_input" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"wake" boolean NOT NULL,
	"delivery" text,
	"author_id" text,
	"origin_kind" text NOT NULL,
	"origin_id" text NOT NULL,
	"key" text,
	"admitted_run_id" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "thread_input_status_check" CHECK ("thread_input"."status" in ('waiting', 'admitted', 'withdrawn', 'dropped')),
	CONSTRAINT "thread_input_kind_check" CHECK ("thread_input"."kind" in ('message', 'notice')),
	CONSTRAINT "thread_input_origin_check" CHECK ("thread_input"."origin_kind" in ('person', 'schedule', 'webhook', 'job', 'subagent', 'task', 'system')),
	CONSTRAINT "thread_input_message_check" CHECK (("thread_input"."kind" = 'message') = ("thread_input"."delivery" is not null and "thread_input"."author_id" is not null)),
	CONSTRAINT "thread_input_admitted_check" CHECK (("thread_input"."status" = 'admitted') = ("thread_input"."admitted_run_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "thread_input" ADD CONSTRAINT "thread_input_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_input" ADD CONSTRAINT "thread_input_branch_id_thread_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "thread_input_key_idx" ON "thread_input" USING btree ("thread_id","key") WHERE "thread_input"."key" is not null;--> statement-breakpoint
CREATE INDEX "thread_input_waiting_idx" ON "thread_input" USING btree ("thread_id","branch_id","seq") WHERE "thread_input"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "thread_input_origin_idx" ON "thread_input" USING btree ("origin_kind","origin_id","seq");;--> statement-breakpoint
-- Inputs already in threads' logs, as the logs say each stands.
with recursive lineage (thread_id, branch_id, upto) as (
  select t.id, t.current_branch_id, null::integer from thread t where true
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
   where e.type = 'message.admitted' and true
   order by m.id, e.seq desc
),
ended as (
  select e.data->>'messageId' as id, max(e.type) as type
    from thread_event e
    join thread t on t.id = e.thread_id
   where e.type in ('message.withdrawn', 'message.dropped') and true
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
            when e.data->>'kind' = 'trigger.fired' and e.data->>'trigger' is not null then 'schedule'
            when e.data->>'kind' = 'webhook.received' and e.data->>'trigger' is not null then 'webhook'
            when e.data->>'kind' = 'call.ended' and e.data->'source'->>'callId' is not null then 'job'
            when e.data->'actor'->>'kind' = 'person' then 'person'
            when e.data->'source'->>'threadId' <> e.thread_id then 'subagent'
            else 'system' end,
       case when e.type = 'message' then e.actor_user_id
            when e.data->>'kind' in ('trigger.fired', 'webhook.received')
                 and e.data->>'trigger' is not null then e.data->>'trigger'
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
            when e.type = 'notification' and exists (
              select 1 from lineage l
               where l.thread_id = e.thread_id and l.branch_id = e.branch_id
                 and (l.upto is null or e.seq <= l.upto)) then 'waiting'
            else 'dropped' end as status
  ) st
 where true
   and (e.type = 'notification'
        or (e.type = 'message' and e.actor_kind = 'user' and e.actor_user_id is not null
            and coalesce((e.data->>'quiet')::boolean, false) = false))
on conflict (id) do nothing;
