-- How far into each thread each person has seen. Everyone who wrote in a thread before this starts
-- as having seen all of it, so older threads do not all turn up as new.
CREATE TABLE `thread_read` (
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`last_seen_seq` integer NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `thread_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `thread_read` (`user_id`, `thread_id`, `last_seen_seq`, `seen_at`)
SELECT DISTINCT e.`actor_user_id`, t.`id`, t.`last_event_seq`, t.`updated_at`
FROM `thread_event` e
JOIN `thread` t ON t.`id` = e.`thread_id`
JOIN `user` u ON u.`id` = e.`actor_user_id`;
