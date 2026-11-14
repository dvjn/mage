CREATE TABLE "thread_word" (
	"thread_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ord" integer NOT NULL,
	"user_id" text NOT NULL,
	"name" text,
	"via" jsonb NOT NULL,
	"call_seq" integer,
	CONSTRAINT "thread_word_thread_id_seq_ord_pk" PRIMARY KEY("thread_id","seq","ord")
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "decided_seq" integer;--> statement-breakpoint
ALTER TABLE "thread_branch" ADD COLUMN "read_seq" integer;--> statement-breakpoint
ALTER TABLE "thread_branch" ADD COLUMN "read_ord" integer;--> statement-breakpoint
ALTER TABLE "thread_word" ADD CONSTRAINT "thread_word_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_word_branch_idx" ON "thread_word" USING btree ("thread_id","branch_id","seq");--> statement-breakpoint
-- Where each call's decision or answer is in its thread's log: a person's approval or answer, else
-- their refusal.
UPDATE "call" SET "decided_seq" = d."seq"
  FROM (SELECT DISTINCT ON (e."thread_id", e."data"->>'callId')
               e."thread_id", e."data"->>'callId' AS "id", e."seq"
          FROM "thread_event" e
         WHERE e."actor_kind" = 'user' AND e."type" IN ('tool.approved', 'tool.answered', 'tool.denied')
         ORDER BY e."thread_id", e."data"->>'callId', (e."type" = 'tool.denied'), e."seq") d
 WHERE d."thread_id" = "call"."thread_id" AND d."id" = "call"."id" AND "call"."decided_by" IS NOT NULL;--> statement-breakpoint
-- Where each restored row's words end in its parent's log.
update thread_branch b set (read_seq, read_ord) = (
  select p.seq, p.ord from (
    select a.seq, i.n * 1000 + case when m.type = 'notification' then 999 else 0 end as ord
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
       and not (e.type = 'notification' and coalesce((e.data->>'wake')::boolean, true))
       and exists (select 1 from thread_branch_source s
                    where s.branch_id = b.id and s.source_branch_id = e.branch_id
                      and (s.until_seq is null or e.seq <= s.until_seq))
  ) p
  order by p.seq desc
  limit 1)
 where b.kind = 'restore' and true;--> statement-breakpoint
-- Whose words each thread's agent read, from every thread's log.
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
      join thread_event m on m.id = i.id and m.type = 'notification'
                         and (coalesce((m.data->>'wake')::boolean, true)
                              -- one that does not wake, whose row a restore left out
                              or exists (
                                select 1 from thread_branch_source s
                                  join thread_branch b on b.id = s.source_branch_id
                                 where s.branch_id = e.branch_id and b.read_seq is not null
                                   and m.seq > b.read_seq and m.seq <= b.fork_seq))
      cross join lateral json_array_elements(coalesce(m.data->'people', '[]'::json))
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
      from json_array_elements(case when e.type = 'notification'
                                         and (e.data->>'wake')::boolean is false
                                    then coalesce(e.data->'people', '[]'::json)
                                    else '[]'::json end)
           with ordinality as p(v, k)
  ) w
 where e.type in ('message.admitted', 'message', 'tool.answered', 'notification')
   and true
on conflict do nothing;
