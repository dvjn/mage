ALTER TABLE "call" ADD COLUMN "model" text;--> statement-breakpoint
-- The model each call is judged under: the one its run replied with.
UPDATE "call" SET "model" = r."model" FROM "run" r WHERE r."id" = "call"."run_id";
