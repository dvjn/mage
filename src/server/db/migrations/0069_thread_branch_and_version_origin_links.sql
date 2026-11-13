-- A thread whose current branch was unset or is gone reads its root branch, as it did. A version
-- published by a call started in the background named that call as its run; each now names the one
-- or the other, and neither once that is gone.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`title` text,
	`title_source` text,
	`model` text,
	`effort` text,
	`created_by` text,
	`root_thread_id` text,
	`current_branch_id` text NOT NULL,
	`org_access` text DEFAULT 'none' NOT NULL,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`last_message_text` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_thread`("id", "space_id", "title", "title_source", "model", "effort", "created_by", "root_thread_id", "current_branch_id", "org_access", "last_event_seq", "last_message_text", "created_at", "updated_at") SELECT "id", "space_id", "title", "title_source", "model", "effort", "created_by", "root_thread_id", (CASE WHEN "current_branch_id" IN (SELECT "id" FROM `thread_branch`) THEN "current_branch_id" ELSE "id" END), "org_access", "last_event_seq", "last_message_text", "created_at", "updated_at" FROM `thread`;--> statement-breakpoint
DROP TABLE `thread`;--> statement-breakpoint
ALTER TABLE `__new_thread` RENAME TO `thread`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `thread_space_idx` ON `thread` (`space_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_artifact_version` (
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`label` text,
	`html` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`icon` text NOT NULL,
	`thread_id` text,
	`run_id` text,
	`background_call_id` text,
	`call_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`artifact_id`, `version`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`background_call_id`) REFERENCES `background_call`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "artifact_version_origin_check" CHECK("run_id" is null or "background_call_id" is null)
);
--> statement-breakpoint
INSERT INTO `__new_artifact_version`("artifact_id", "version", "label", "html", "title", "description", "icon", "thread_id", "run_id", "background_call_id", "call_id", "created_at") SELECT "artifact_id", "version", "label", "html", "title", "description", "icon", "thread_id", (CASE WHEN "run_id" IN (SELECT "id" FROM `run`) THEN "run_id" END), (CASE WHEN "run_id" IN (SELECT "id" FROM `background_call`) THEN "run_id" END), "call_id", "created_at" FROM `artifact_version`;--> statement-breakpoint
DROP TABLE `artifact_version`;--> statement-breakpoint
ALTER TABLE `__new_artifact_version` RENAME TO `artifact_version`;