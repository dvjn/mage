CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`sharing` text DEFAULT 'thread' NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_thread_idx` ON `artifact` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `artifact_asset` (
	`artifact_id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`artifact_id`, `name`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifact_org_setting` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`public_allowed` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifact_space_setting` (
	`space_id` text PRIMARY KEY NOT NULL,
	`public_allowed` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifact_version` (
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`label` text,
	`html` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`icon` text NOT NULL,
	`run_id` text,
	`call_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`artifact_id`, `version`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade
);
