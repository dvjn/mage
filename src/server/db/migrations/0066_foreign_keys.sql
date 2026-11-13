-- Rows that point at what is gone, of which there should be none, are mended or left out first.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger_seq` integer NOT NULL,
	`model` text,
	`asked_model` text,
	`asked_effort` text,
	`continues_run_id` text,
	`reason` text,
	`created_by` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`cancel_requested_at` integer,
	`cancel_requested_by` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`error` text,
	`error_kind` text,
	`error_detail` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`continues_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_run`("id", "thread_id", "branch_id", "status", "trigger_seq", "model", "asked_model", "asked_effort", "continues_run_id", "reason", "created_by", "attempt", "cancel_requested_at", "cancel_requested_by", "lease_owner", "lease_expires_at", "lease_epoch", "error", "error_kind", "error_detail", "input_tokens", "output_tokens", "created_at", "started_at", "ended_at", "updated_at") SELECT "id", "thread_id", (CASE WHEN "branch_id" IN (SELECT "id" FROM `thread_branch`) THEN "branch_id" ELSE "thread_id" END), "status", "trigger_seq", "model", "asked_model", "asked_effort", (CASE WHEN "continues_run_id" IN (SELECT "id" FROM `run`) THEN "continues_run_id" END), "reason", "created_by", "attempt", "cancel_requested_at", "cancel_requested_by", "lease_owner", "lease_expires_at", "lease_epoch", "error", "error_kind", "error_detail", "input_tokens", "output_tokens", "created_at", "started_at", "ended_at", "updated_at" FROM `run`;--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
ALTER TABLE `__new_run` RENAME TO `run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `run_thread_idx` ON `run` (`thread_id`);--> statement-breakpoint
CREATE INDEX `run_status_idx` ON `run` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_active_idx` ON `run` (`branch_id`) WHERE "run"."status" in ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE TABLE `__new_thread_event` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_user_id` text,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_thread_event`("id", "thread_id", "branch_id", "seq", "type", "actor_kind", "actor_user_id", "data", "created_at") SELECT "id", "thread_id", (CASE WHEN "branch_id" IN (SELECT "id" FROM `thread_branch`) THEN "branch_id" ELSE "thread_id" END), "seq", "type", "actor_kind", "actor_user_id", "data", "created_at" FROM `thread_event`;--> statement-breakpoint
DROP TABLE `thread_event`;--> statement-breakpoint
ALTER TABLE `__new_thread_event` RENAME TO `thread_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `thread_event_thread_seq_idx` ON `thread_event` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `thread_event_thread_type_idx` ON `thread_event` (`thread_id`,`type`,`seq`);--> statement-breakpoint
CREATE INDEX `thread_event_branch_idx` ON `thread_event` (`branch_id`,`seq`);--> statement-breakpoint
CREATE TABLE `__new_background_call` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`input` text,
	`status` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_background_call`("id", "thread_id", "run_id", "tool_id", "input", "status", "lease_owner", "lease_expires_at", "lease_epoch", "created_at", "ended_at") SELECT "id", "thread_id", "run_id", "tool_id", "input", "status", "lease_owner", "lease_expires_at", "lease_epoch", "created_at", "ended_at" FROM `background_call` WHERE "run_id" IN (SELECT "id" FROM `run`);--> statement-breakpoint
DROP TABLE `background_call`;--> statement-breakpoint
ALTER TABLE `__new_background_call` RENAME TO `background_call`;--> statement-breakpoint
CREATE INDEX `background_call_thread_idx` ON `background_call` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_aside` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`row_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_aside`("id", "thread_id", "branch_id", "row_id", "user_id", "created_at") SELECT "id", "thread_id", (CASE WHEN "branch_id" IN (SELECT "id" FROM `thread_branch`) THEN "branch_id" ELSE "thread_id" END), "row_id", "user_id", "created_at" FROM `aside`;--> statement-breakpoint
DROP TABLE `aside`;--> statement-breakpoint
ALTER TABLE `__new_aside` RENAME TO `aside`;--> statement-breakpoint
CREATE INDEX `aside_thread_user_idx` ON `aside` (`thread_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `__new_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`title` text,
	`title_source` text,
	`model` text,
	`effort` text,
	`created_by` text,
	`root_thread_id` text,
	`current_branch_id` text,
	`org_access` text DEFAULT 'none' NOT NULL,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`last_message_text` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_thread`("id", "space_id", "title", "title_source", "model", "effort", "created_by", "root_thread_id", "current_branch_id", "org_access", "last_event_seq", "last_message_text", "created_at", "updated_at") SELECT "id", "space_id", "title", "title_source", "model", "effort", "created_by", (CASE WHEN "root_thread_id" IN (SELECT "id" FROM `thread`) THEN "root_thread_id" END), "current_branch_id", "org_access", "last_event_seq", "last_message_text", "created_at", "updated_at" FROM `thread`;--> statement-breakpoint
DROP TABLE `thread`;--> statement-breakpoint
ALTER TABLE `__new_thread` RENAME TO `thread`;--> statement-breakpoint
CREATE INDEX `thread_space_idx` ON `thread` (`space_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_thread_branch` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`parent_branch_id` text,
	`fork_seq` integer,
	`kind` text NOT NULL,
	`row_id` text,
	`group_row_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_thread_branch`("id", "thread_id", "parent_branch_id", "fork_seq", "kind", "row_id", "group_row_id", "created_by", "created_at") SELECT "id", "thread_id", (CASE WHEN "parent_branch_id" IN (SELECT "id" FROM `thread_branch`) THEN "parent_branch_id" END), "fork_seq", "kind", "row_id", "group_row_id", "created_by", "created_at" FROM `thread_branch`;--> statement-breakpoint
DROP TABLE `thread_branch`;--> statement-breakpoint
ALTER TABLE `__new_thread_branch` RENAME TO `thread_branch`;--> statement-breakpoint
CREATE INDEX `thread_branch_thread_idx` ON `thread_branch` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_thread_branch_source` (
	`branch_id` text NOT NULL,
	`source_branch_id` text NOT NULL,
	`until_seq` integer,
	PRIMARY KEY(`branch_id`, `source_branch_id`),
	FOREIGN KEY (`branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_branch_id`) REFERENCES `thread_branch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_thread_branch_source`("branch_id", "source_branch_id", "until_seq") SELECT "branch_id", "source_branch_id", "until_seq" FROM `thread_branch_source` WHERE "source_branch_id" IN (SELECT "id" FROM `thread_branch`);--> statement-breakpoint
DROP TABLE `thread_branch_source`;--> statement-breakpoint
ALTER TABLE `__new_thread_branch_source` RENAME TO `thread_branch_source`;