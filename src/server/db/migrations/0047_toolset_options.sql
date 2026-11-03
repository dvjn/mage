CREATE TABLE `org_toolset_option` (
	`organization_id` text NOT NULL,
	`toolset_id` text NOT NULL,
	`option` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `toolset_id`, `option`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_toolset_option` (
	`space_id` text NOT NULL,
	`toolset_id` text NOT NULL,
	`option` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`space_id`, `toolset_id`, `option`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
