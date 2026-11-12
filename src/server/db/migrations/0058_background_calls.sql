CREATE TABLE `background_call` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`input` text,
	`model` text,
	`steered_by` text NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `background_call_thread_idx` ON `background_call` (`thread_id`,`created_at`);