CREATE TABLE `call_output` (
	`call_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`progress` text,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `call_output_thread_idx` ON `call_output` (`thread_id`);--> statement-breakpoint
CREATE TABLE `call_output_chunk` (
	`call_id` text NOT NULL,
	`offset` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`call_id`, `offset`),
	FOREIGN KEY (`call_id`) REFERENCES `call_output`(`call_id`) ON UPDATE cascade ON DELETE cascade
);
