CREATE TABLE `space_mcp_server_setting` (
	`space_id` text NOT NULL,
	`server_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`space_id`, `server_id`),
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `mcp_server` ADD `enabled` integer DEFAULT true NOT NULL;