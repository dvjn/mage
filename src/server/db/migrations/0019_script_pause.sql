CREATE TABLE "script_pause" (
	"thread_id" text NOT NULL,
	"call_id" text NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"printed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "script_pause_thread_id_call_id_pk" PRIMARY KEY("thread_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "script_pause" ADD CONSTRAINT "script_pause_thread_id_call_id_call_thread_id_id_fk" FOREIGN KEY ("thread_id","call_id") REFERENCES "public"."call"("thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_parent_idx" ON "call" USING btree ("thread_id","parent_id") WHERE "call"."parent_id" is not null;--> statement-breakpoint
UPDATE "call" c SET "parent_id" = e."data"->>'within' FROM "thread_event" e WHERE e."thread_id" = c."thread_id" AND e."seq" = c."seq" AND e."type" = 'tool.requested' AND e."data"->>'within' IS NOT NULL;