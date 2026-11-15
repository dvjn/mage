ALTER TABLE "thread_background_seen" RENAME TO "thread_activity_seen";--> statement-breakpoint
ALTER TABLE "run" RENAME COLUMN "trigger_seq" TO "woken_by_seq";--> statement-breakpoint
ALTER TABLE "thread_activity_seen" RENAME CONSTRAINT "thread_background_seen_user_id_user_id_fk" TO "thread_activity_seen_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "thread_activity_seen" RENAME CONSTRAINT "thread_background_seen_thread_id_thread_id_fk" TO "thread_activity_seen_thread_id_thread_id_fk";--> statement-breakpoint
ALTER TABLE "thread_activity_seen" RENAME CONSTRAINT "thread_background_seen_user_id_thread_id_kind_pk" TO "thread_activity_seen_user_id_thread_id_kind_pk";--> statement-breakpoint
-- What the agent is told is a notice, and carries everyone whose words count as its influence.
UPDATE "thread_event" SET "type" = 'notice' WHERE "type" = 'notification';--> statement-breakpoint
UPDATE "thread_event"
   SET "data" = (("data"::jsonb - 'people') || jsonb_build_object('influence', "data"::jsonb -> 'people'))::json
 WHERE "type" = 'notice' AND "data"::jsonb ? 'people';--> statement-breakpoint
-- A call its run's end left behind was cancelled.
UPDATE "thread_event" SET "data" = jsonb_set("data"::jsonb, '{reason}', '"cancelled"')::json
 WHERE "type" = 'tool.denied' AND "data"->>'reason' = 'stopped';--> statement-breakpoint
-- A schedule's firing is told by its own kind, and a schedule's or a webhook's notice names it by
-- its own kind; a change to one opens the schedules' or the webhooks' place in the tray.
UPDATE "thread_event"
   SET "data" = (("data"::jsonb - 'trigger')
                 || jsonb_build_object('kind', 'schedule.fired', 'scheduleId', "data"::jsonb -> 'trigger'))::json
 WHERE "type" = 'notice' AND "data"->>'kind' = 'trigger.fired' AND "data"::jsonb ? 'trigger';--> statement-breakpoint
UPDATE "thread_event" SET "data" = jsonb_set("data"::jsonb, '{kind}', '"schedule.fired"')::json
 WHERE "type" = 'notice' AND "data"->>'kind' = 'trigger.fired';--> statement-breakpoint
UPDATE "thread_event"
   SET "data" = (("data"::jsonb - 'trigger') || jsonb_build_object('webhookId', "data"::jsonb -> 'trigger'))::json
 WHERE "type" = 'notice' AND "data"->>'kind' = 'webhook.received' AND "data"::jsonb ? 'trigger';--> statement-breakpoint
UPDATE "thread_event" SET "data" = jsonb_set("data"::jsonb, '{tray}', '"schedules"')::json
 WHERE "type" = 'notice' AND "data"->>'tray' = 'triggers';--> statement-breakpoint
UPDATE "thread_activity_seen" SET "kind" = 'schedules' WHERE "kind" = 'triggers';--> statement-breakpoint
-- The tools' ids as the agent knows them. What turns a tool or toolset on or off, or sets its
-- policy, and listing or deleting both kinds, goes to both schedules and webhooks, so nobody gains
-- or loses a permission; a call already made goes to the kind it was of.
INSERT INTO "tool_setting" ("organization_id", "space_id", "tool_id", "policy_id")
  SELECT "organization_id", "space_id", replace("tool_id", 'triggers.', 'webhooks.'), "policy_id"
    FROM "tool_setting" WHERE "tool_id" IN ('triggers.list', 'triggers.delete');--> statement-breakpoint
UPDATE "tool_setting" s SET "tool_id" = r."new" FROM (VALUES ('calls.start', 'jobs.start'), ('calls.status', 'jobs.check'), ('calls.list', 'jobs.list'),
          ('calls.cancel', 'jobs.cancel'), ('triggers.wake_at', 'schedules.wake_at'),
          ('triggers.schedule', 'schedules.add'), ('triggers.add_webhook', 'webhooks.add'),
          ('triggers.list', 'schedules.list'), ('triggers.delete', 'schedules.delete')) AS r("old", "new") WHERE s."tool_id" = r."old";--> statement-breakpoint
INSERT INTO "thread_tool" ("thread_id", "tool_id", "call_id", "position")
  SELECT "thread_id", replace("tool_id", 'triggers.', 'webhooks.'), "call_id", "position"
    FROM "thread_tool" WHERE "tool_id" IN ('triggers.list', 'triggers.delete');--> statement-breakpoint
UPDATE "thread_tool" t SET "tool_id" = r."new" FROM (VALUES ('calls.start', 'jobs.start'), ('calls.status', 'jobs.check'), ('calls.list', 'jobs.list'),
          ('calls.cancel', 'jobs.cancel'), ('triggers.wake_at', 'schedules.wake_at'),
          ('triggers.schedule', 'schedules.add'), ('triggers.add_webhook', 'webhooks.add'),
          ('triggers.list', 'schedules.list'), ('triggers.delete', 'schedules.delete')) AS r("old", "new") WHERE t."tool_id" = r."old";--> statement-breakpoint
INSERT INTO "toolset_setting" ("organization_id", "space_id", "toolset_id", "enabled")
  SELECT "organization_id", "space_id", 'webhooks', "enabled"
    FROM "toolset_setting" WHERE "toolset_id" = 'triggers';--> statement-breakpoint
UPDATE "toolset_setting" SET "toolset_id" = 'schedules' WHERE "toolset_id" = 'triggers';--> statement-breakpoint
UPDATE "toolset_setting" SET "toolset_id" = 'jobs' WHERE "toolset_id" = 'calls';--> statement-breakpoint
INSERT INTO "toolset_option" ("organization_id", "space_id", "toolset_id", "option", "enabled")
  SELECT "organization_id", "space_id", 'webhooks', "option", "enabled"
    FROM "toolset_option" WHERE "toolset_id" = 'triggers';--> statement-breakpoint
UPDATE "toolset_option" SET "toolset_id" = 'schedules' WHERE "toolset_id" = 'triggers';--> statement-breakpoint
UPDATE "toolset_option" SET "toolset_id" = 'jobs' WHERE "toolset_id" = 'calls';--> statement-breakpoint
-- A delete already asked for went to whichever kind held the id.
UPDATE "call" c SET "tool_id" = 'webhooks.delete'
  FROM "thread_event" e, "webhook" w
 WHERE c."tool_id" = 'triggers.delete' AND e."thread_id" = c."thread_id" AND e."seq" = c."seq"
   AND e."type" = 'tool.requested' AND w."id" = e."data"->'input'->>'id';--> statement-breakpoint
UPDATE "call" c SET "tool_id" = r."new" FROM (VALUES ('calls.start', 'jobs.start'), ('calls.status', 'jobs.check'), ('calls.list', 'jobs.list'),
          ('calls.cancel', 'jobs.cancel'), ('triggers.wake_at', 'schedules.wake_at'),
          ('triggers.schedule', 'schedules.add'), ('triggers.add_webhook', 'webhooks.add'),
          ('triggers.list', 'schedules.list'), ('triggers.delete', 'schedules.delete')) AS r("old", "new") WHERE c."tool_id" = r."old";--> statement-breakpoint
UPDATE "thread_event" e SET "data" = jsonb_set(e."data"::jsonb, '{toolId}', '"webhooks.delete"')::json
  FROM "webhook" w
 WHERE e."type" = 'tool.requested' AND e."data"->>'toolId' = 'triggers.delete'
   AND w."id" = e."data"->'input'->>'id';--> statement-breakpoint
UPDATE "thread_event" e SET "data" = jsonb_set(e."data"::jsonb, '{toolId}', to_jsonb(r."new"))::json
  FROM (VALUES ('calls.start', 'jobs.start'), ('calls.status', 'jobs.check'), ('calls.list', 'jobs.list'),
          ('calls.cancel', 'jobs.cancel'), ('triggers.wake_at', 'schedules.wake_at'),
          ('triggers.schedule', 'schedules.add'), ('triggers.add_webhook', 'webhooks.add'),
          ('triggers.list', 'schedules.list'), ('triggers.delete', 'schedules.delete')) AS r("old", "new")
 WHERE e."type" = 'tool.requested' AND e."data"->>'toolId' = r."old";--> statement-breakpoint
-- A job names the tool it runs.
UPDATE "thread_event" e SET "data" = jsonb_set(e."data"::jsonb, '{input,tool}', to_jsonb(r."new"))::json
  FROM (VALUES ('calls.start', 'jobs.start'), ('calls.status', 'jobs.check'), ('calls.list', 'jobs.list'),
          ('calls.cancel', 'jobs.cancel'), ('triggers.wake_at', 'schedules.wake_at'),
          ('triggers.schedule', 'schedules.add'), ('triggers.add_webhook', 'webhooks.add'),
          ('triggers.list', 'schedules.list'), ('triggers.delete', 'schedules.delete')) AS r("old", "new")
 WHERE e."type" = 'tool.requested' AND e."data"->>'toolId' = 'jobs.start'
   AND e."data"->'input'->>'tool' = r."old";--> statement-breakpoint
-- The toolset a schedule's or a webhook's tool was asked for under is called as it is now.
UPDATE "thread_event" SET "data" = jsonb_set("data"::jsonb, '{toolset}', '"Schedules"')::json
 WHERE "type" = 'tool.requested' AND "data"->>'toolset' = 'Triggers'
   AND "data"->>'toolId' LIKE 'schedules.%';--> statement-breakpoint
UPDATE "thread_event" SET "data" = jsonb_set("data"::jsonb, '{toolset}', '"Webhooks"')::json
 WHERE "type" = 'tool.requested' AND "data"->>'toolset' = 'Triggers'
   AND "data"->>'toolId' LIKE 'webhooks.%';
