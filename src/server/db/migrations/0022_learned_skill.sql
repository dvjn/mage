CREATE TABLE "learned_skill" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"files" json NOT NULL,
	"thread_id" text,
	"call_id" text,
	"influence" json NOT NULL,
	"approved_by" text,
	"supersedes_id" text,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learned_skill" ADD CONSTRAINT "learned_skill_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_skill" ADD CONSTRAINT "learned_skill_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_skill" ADD CONSTRAINT "learned_skill_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_skill" ADD CONSTRAINT "learned_skill_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learned_skill_space_idx" ON "learned_skill" USING btree ("space_id","retired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learned_skill_call_idx" ON "learned_skill" USING btree ("thread_id","call_id") WHERE "learned_skill"."call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "learned_skill_name_idx" ON "learned_skill" USING btree ("space_id","name") WHERE "learned_skill"."retired_at" is null;