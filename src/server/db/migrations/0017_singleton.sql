CREATE TABLE "singleton" (
	"name" text PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" integer DEFAULT 0 NOT NULL
);
