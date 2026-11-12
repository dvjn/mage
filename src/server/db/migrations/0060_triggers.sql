CREATE TABLE `thread_trigger` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`cron` text,
	`timezone` text,
	`prompt` text NOT NULL,
	`steered_by` text NOT NULL,
	`created_by` text NOT NULL,
	`status` text NOT NULL,
	`next_run_at` integer,
	`pending_fire_at` integer,
	`claimed_by` text,
	`claimed_until` integer,
	`last_fired_at` integer,
	`hook_token` text,
	`secret_key_version` integer,
	`secret` blob,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_trigger_hook_token_idx` ON `thread_trigger` (`hook_token`);--> statement-breakpoint
CREATE INDEX `thread_trigger_thread_idx` ON `thread_trigger` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `thread_trigger_due_idx` ON `thread_trigger` (`status`,`next_run_at`);