CREATE TABLE `thread_tool` (
	`thread_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`call_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `tool_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `run` DROP COLUMN `tools_on`;