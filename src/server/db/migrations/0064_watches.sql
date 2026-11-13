CREATE TABLE `thread_watch` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`until` text NOT NULL,
	`call_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_watch_thread_idx` ON `thread_watch` (`thread_id`);--> statement-breakpoint
CREATE INDEX `thread_watch_owner_idx` ON `thread_watch` (`owner_id`,`kind`);--> statement-breakpoint
CREATE TABLE `thread_watch_subject` (
	`watch_id` text NOT NULL,
	`subject_id` text NOT NULL,
	PRIMARY KEY(`watch_id`, `subject_id`),
	FOREIGN KEY (`watch_id`) REFERENCES `thread_watch`(`id`) ON UPDATE no action ON DELETE cascade
);
