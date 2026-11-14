CREATE TABLE "call" (
	"thread_id" text NOT NULL,
	"id" text NOT NULL,
	"branch_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"risk" text NOT NULL,
	"status" text NOT NULL,
	"waits_for" text,
	"background" boolean NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"move_requested_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_thread_id_id_pk" PRIMARY KEY("thread_id","id"),
	CONSTRAINT "call_status_check" CHECK ("call"."status" in ('ready', 'waiting', 'running', 'completed', 'failed', 'denied', 'skipped', 'stale', 'interrupted', 'cancelled')),
	CONSTRAINT "call_waits_for_check" CHECK ("call"."waits_for" is null or "call"."status" = 'waiting')
);
--> statement-breakpoint
ALTER TABLE "artifact_version" DROP CONSTRAINT "artifact_version_background_call_id_background_call_id_fk";--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_waiting_idx" ON "call" USING btree ("thread_id") WHERE "call"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "call_running_job_idx" ON "call" USING btree ("status","lease_expires_at") WHERE "call"."background" and "call"."status" = 'running';--> statement-breakpoint
CREATE INDEX "call_open_idx" ON "call" USING btree ("thread_id","run_id") WHERE "call"."status" in ('ready', 'waiting', 'running');--> statement-breakpoint
-- A job's events name the run that asked for it, where they named the job itself.
update thread_event e
   set data = regexp_replace(e.data::text, '"runId":"' || b.id || '"', '"runId":"' || b.run_id || '"')::json
  from background_call b
 where e.thread_id = b.thread_id
   and e.type in ('tool.requested', 'tool.approved', 'tool.denied', 'tool.ran')
   and e.data->>'callId' = b.id
   and e.data->>'runId' = b.id;--> statement-breakpoint
-- Calls already in threads' logs, as the logs say each stands, and jobs as their rows said.
with requested as (
  select distinct on (e.thread_id, e.data->>'callId')
         e.thread_id, e.data->>'callId' as id, e.branch_id, e.data->>'runId' as run_id,
         e.data->>'toolId' as tool_id, coalesce(e.data->>'risk', 'normal') as risk,
         coalesce((e.data->>'background')::boolean, false) as background,
         coalesce((e.data->>'waits')::boolean, false) as waits, e.seq, e.created_at
    from thread_event e
    join thread t on t.id = e.thread_id
   where e.type = 'tool.requested' and true
   order by e.thread_id, e.data->>'callId', e.seq
),
settled as (
  select distinct on (e.thread_id, e.data->>'callId')
         e.thread_id, e.data->>'callId' as id, e.type, e.data->>'reason' as reason,
         (e.data->>'ok')::boolean as ok, e.actor_user_id, e.created_at
    from thread_event e
    join thread t on t.id = e.thread_id
   where e.type in ('tool.ran', 'tool.denied') and true
   -- The fold takes the last result, else the first refusal.
   order by e.thread_id, e.data->>'callId', (e.type = 'tool.ran') desc,
            case when e.type = 'tool.ran' then -e.seq else e.seq end
),
decided as (
  select distinct on (e.thread_id, e.data->>'callId')
         e.thread_id, e.data->>'callId' as id, e.actor_user_id, e.data->>'scope' as scope,
         e.created_at
    from thread_event e
    join thread t on t.id = e.thread_id
   where e.type in ('tool.approved', 'tool.answered') and true
   order by e.thread_id, e.data->>'callId', e.seq
),
ended_runs as (
  select e.thread_id, e.data->>'runId' as run_id
    from thread_event e
    join thread t on t.id = e.thread_id
   where e.type in ('run.completed', 'run.failed', 'run.cancelled') and true
)
insert into call (thread_id, id, branch_id, run_id, tool_id, risk, status, waits_for,
                  background, lease_owner, lease_expires_at, lease_epoch, decided_by,
                  decided_at, scope, created_at, started_at, ended_at)
select r.thread_id, r.id, r.branch_id, r.run_id, r.tool_id, r.risk, s.status,
       case when s.status = 'waiting'
            then case when r.tool_id = 'thread.ask' then 'answer' else 'decision' end end,
       r.background,
       case when s.status = 'running' then s.lease_owner end,
       case when s.status = 'running' then s.lease_expires_at end,
       coalesce(s.lease_epoch, 0),
       coalesce(d.actor_user_id, case when x.type = 'tool.denied' then x.actor_user_id end),
       coalesce(d.created_at, case when x.type = 'tool.denied' and x.actor_user_id is not null
                                   then x.created_at end),
       case when d.scope in ('once', 'for_now') then d.scope
            when d.id is not null then 'once' end,
       r.created_at,
       case when s.status in ('running', 'completed', 'failed', 'interrupted') then r.created_at end,
       case when s.status in ('ready', 'waiting', 'running') then null
            else coalesce(x.created_at, r.created_at) end
  from requested r
  left join settled x on x.thread_id = r.thread_id and x.id = r.id
  left join decided d on d.thread_id = r.thread_id and d.id = r.id
  left join background_call b on b.id = r.id and r.background
  cross join lateral (
    select case
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
             when r.background and b.status = 'pending' then 'waiting'
                       when r.background and b.status = 'running' then 'running'
                       when r.background and b.status = 'done' then 'completed'
                       when r.background and b.status in ('failed', 'interrupted', 'cancelled')
                            then b.status
             when exists (select 1 from ended_runs u
                           where u.thread_id = r.thread_id and u.run_id = r.run_id)
                  and not r.background then 'cancelled'
             when d.id is not null then 'ready'
             when r.waits then 'waiting'
             else 'ready'
           end as status,
           b.lease_owner, b.lease_expires_at, b.lease_epoch
  ) s
on conflict do nothing;--> statement-breakpoint
ALTER TABLE "background_call" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "background_call" CASCADE;
