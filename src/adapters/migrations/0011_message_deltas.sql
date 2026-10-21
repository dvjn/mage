CREATE TABLE `message_delta` (
	`thread_id` text NOT NULL,
	`message_id` text NOT NULL,
	`idx` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`message_id`, `idx`),
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_delta_thread_idx` ON `message_delta` (`thread_id`);