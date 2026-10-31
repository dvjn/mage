-- Tools an org turns off, and a space's choices for each: off there, and the level its messagers and
-- guests get.
CREATE TABLE `org_tool_setting` (
	`organization_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `tool_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_tool_setting` (
	`space_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`messager_level` text,
	`guest_level` text,
	PRIMARY KEY(`space_id`, `tool_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
