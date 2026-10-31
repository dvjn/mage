CREATE TABLE `skill` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`space_id` text,
	`source_id` text,
	`path` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`files` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `skill_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `skill_org_idx` ON `skill` (`organization_id`);--> statement-breakpoint
CREATE INDEX `skill_space_idx` ON `skill` (`space_id`);--> statement-breakpoint
CREATE INDEX `skill_source_idx` ON `skill` (`source_id`);--> statement-breakpoint
CREATE TABLE `skill_source` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`space_id` text,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`ref` text,
	`resolved_ref` text,
	`subpath` text,
	`commit` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`token_key_version` integer,
	`token` blob,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `skill_source_org_idx` ON `skill_source` (`organization_id`);--> statement-breakpoint
CREATE INDEX `skill_source_space_idx` ON `skill_source` (`space_id`);--> statement-breakpoint
CREATE TABLE `space_skill_setting` (
	`space_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`space_id`, `skill_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skill`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_skill_source_setting` (
	`space_id` text NOT NULL,
	`source_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`space_id`, `source_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `skill_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `org_setting` ADD `space_skills` integer DEFAULT true NOT NULL;