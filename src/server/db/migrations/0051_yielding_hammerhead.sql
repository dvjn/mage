CREATE TABLE `org_builtin_skill_setting` (
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `key`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_builtin_skill_setting` (
	`space_id` text NOT NULL,
	`key` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`space_id`, `key`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
