CREATE TABLE `bus_message` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`origin` text NOT NULL,
	`channel` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `background_call` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `background_call` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `background_call` ADD `lease_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_trigger` DROP COLUMN `pending_fire_at`;--> statement-breakpoint
ALTER TABLE `thread_trigger` DROP COLUMN `claimed_by`;--> statement-breakpoint
ALTER TABLE `thread_trigger` DROP COLUMN `claimed_until`;