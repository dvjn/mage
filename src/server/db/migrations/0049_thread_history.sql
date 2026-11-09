CREATE TABLE `aside` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`row_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `aside_thread_user_idx` ON `aside` (`thread_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `aside_turn` (
	`id` text PRIMARY KEY NOT NULL,
	`aside_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`model` text,
	`failed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`aside_id`) REFERENCES `aside`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `aside_turn_aside_idx` ON `aside_turn` (`aside_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_branch` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`parent_branch_id` text,
	`fork_seq` integer,
	`kind` text NOT NULL,
	`row_id` text,
	`group_row_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `thread_branch_thread_idx` ON `thread_branch` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_branch_source` (
	`branch_id` text NOT NULL,
	`source_branch_id` text NOT NULL,
	`until_seq` integer,
	PRIMARY KEY(`branch_id`, `source_branch_id`),
	FOREIGN KEY (`branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `run_active_idx`;--> statement-breakpoint
ALTER TABLE `run` ADD `branch_id` text;--> statement-breakpoint
ALTER TABLE `run` ADD `asked_model` text;--> statement-breakpoint
ALTER TABLE `run` ADD `asked_effort` text;--> statement-breakpoint
ALTER TABLE `thread` ADD `current_branch_id` text;--> statement-breakpoint
ALTER TABLE `thread_event` ADD `branch_id` text;--> statement-breakpoint
INSERT INTO `thread_branch` (`id`, `thread_id`, `kind`, `created_by`, `created_at`)
  SELECT `id`, `id`, 'root', `created_by`, `created_at` FROM `thread`;--> statement-breakpoint
INSERT INTO `thread_branch_source` (`branch_id`, `source_branch_id`) SELECT `id`, `id` FROM `thread`;--> statement-breakpoint
UPDATE `thread` SET `current_branch_id` = `id`;--> statement-breakpoint
UPDATE `thread_event` SET `branch_id` = `thread_id`;--> statement-breakpoint
UPDATE `run` SET `branch_id` = `thread_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `run_active_idx` ON `run` (`branch_id`) WHERE "run"."status" in ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX `thread_event_branch_idx` ON `thread_event` (`branch_id`,`seq`);