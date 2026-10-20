CREATE TABLE `space` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `space_org_idx` ON `space` (`organization_id`);--> statement-breakpoint
CREATE TABLE `space_member` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_member_user_idx` ON `space_member` (`user_id`);--> statement-breakpoint
INSERT INTO `space` (`id`, `organization_id`, `kind`, `name`, `is_primary`, `created_by`)
SELECT lower(hex(randomblob(16))), `organization`.`id`, 'personal', 'Your space', 1, `member`.`user_id`
FROM `organization`
INNER JOIN `member` ON `member`.`organization_id` = `organization`.`id` AND `member`.`role` = 'owner'
WHERE `organization`.`kind` = 'personal'
	AND NOT EXISTS (SELECT 1 FROM `space` WHERE `space`.`organization_id` = `organization`.`id`);
--> statement-breakpoint
INSERT INTO `space_member` (`space_id`, `user_id`, `role`, `source`)
SELECT `id`, `created_by`, 'owner', 'direct' FROM `space`
WHERE `is_primary` = 1 AND `created_by` IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM `space_member` WHERE `space_member`.`space_id` = `space`.`id`);
