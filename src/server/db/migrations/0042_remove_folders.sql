DROP TABLE `folder`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`title` text,
	`title_source` text,
	`model` text,
	`effort` text,
	`created_by` text,
	`parent_thread_id` text,
	`root_thread_id` text,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`last_message_text` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_thread`("id", "space_id", "title", "title_source", "model", "effort", "created_by", "parent_thread_id", "root_thread_id", "last_event_seq", "last_message_text", "created_at", "updated_at") SELECT "id", "space_id", "title", "title_source", "model", "effort", "created_by", "parent_thread_id", "root_thread_id", "last_event_seq", "last_message_text", "created_at", "updated_at" FROM `thread`;--> statement-breakpoint
DROP TABLE `thread`;--> statement-breakpoint
ALTER TABLE `__new_thread` RENAME TO `thread`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `thread_space_idx` ON `thread` (`space_id`,`updated_at`);