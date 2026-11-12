CREATE TABLE `thread_task` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`assignee` text,
	`position` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_task_thread_idx` ON `thread_task` (`thread_id`,`position`);--> statement-breakpoint
CREATE TABLE `thread_task_watch` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`task_ids` text NOT NULL,
	`until` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_task_watch_thread_idx` ON `thread_task_watch` (`thread_id`);--> statement-breakpoint
CREATE INDEX `thread_task_watch_owner_idx` ON `thread_task_watch` (`owner_id`);--> statement-breakpoint
ALTER TABLE `subagent` ADD `share_tasks` integer DEFAULT false NOT NULL;