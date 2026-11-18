CREATE TABLE "memory_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"type" text NOT NULL,
	"topic" text NOT NULL,
	"text" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "memory_entry"."topic" || ' ' || "memory_entry"."text")) STORED,
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
ALTER TABLE "memory_entry" ADD CONSTRAINT "memory_entry_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entry" ADD CONSTRAINT "memory_entry_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entry" ADD CONSTRAINT "memory_entry_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entry" ADD CONSTRAINT "memory_entry_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_entry_space_idx" ON "memory_entry" USING btree ("space_id","retired_at","created_at");--> statement-breakpoint
CREATE INDEX "memory_entry_search_idx" ON "memory_entry" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_entry_call_idx" ON "memory_entry" USING btree ("thread_id","call_id") WHERE "memory_entry"."call_id" is not null;