CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger_seq` integer NOT NULL,
	`model` text,
	`continues_run_id` text,
	`reason` text,
	`created_by` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`cancel_requested_at` integer,
	`cancel_requested_by` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`error` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_thread_idx` ON `run` (`thread_id`);--> statement-breakpoint
CREATE INDEX `run_status_idx` ON `run` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_active_idx` ON `run` (`thread_id`) WHERE "run"."status" in ('queued', 'running', 'waiting');--> statement-breakpoint
UPDATE `thread_event` SET `data` = json_set(`data`, '$.quiet', json('true'))
WHERE `type` = 'message' AND json_type(`data`, '$.quiet') IS NULL;
