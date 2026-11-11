CREATE TABLE `thread_group_guest` (
	`thread_id` text NOT NULL,
	`group_id` text NOT NULL,
	`invited_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`role` text DEFAULT 'message' NOT NULL,
	`access_until` integer,
	`revoked_at` integer,
	`revoked_by` text,
	PRIMARY KEY(`thread_id`, `group_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `scim_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `thread_group_guest_group_idx` ON `thread_group_guest` (`group_id`);--> statement-breakpoint
CREATE TABLE `artifact_group_share` (
	`artifact_id` text NOT NULL,
	`group_id` text NOT NULL,
	`role` text DEFAULT 'view' NOT NULL,
	`shared_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`artifact_id`, `group_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `scim_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shared_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifact_group_share_group_idx` ON `artifact_group_share` (`group_id`);