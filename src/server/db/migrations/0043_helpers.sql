CREATE TABLE `helper` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`parent_thread_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text,
	`tools` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `helper_parent_idx` ON `helper` (`parent_thread_id`,`created_at`);