CREATE TABLE `org_toolset_setting` (
	`organization_id` text NOT NULL,
	`toolset_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `toolset_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_toolset_setting` (
	`space_id` text NOT NULL,
	`toolset_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`space_id`, `toolset_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
