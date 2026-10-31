CREATE TABLE `mcp_credential` (
	`server_id` text NOT NULL,
	`holder_kind` text NOT NULL,
	`holder_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`sealed` blob NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`server_id`, `holder_kind`, `holder_id`),
	FOREIGN KEY (`server_id`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`space_id` text,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth_kind` text NOT NULL,
	`settings` text NOT NULL,
	`transport` text,
	`status` text NOT NULL,
	`error` text,
	`server_info` text,
	`tools` text NOT NULL,
	`tools_read_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mcp_server_org_idx` ON `mcp_server` (`organization_id`);--> statement-breakpoint
CREATE INDEX `mcp_server_space_idx` ON `mcp_server` (`space_id`);--> statement-breakpoint
ALTER TABLE `org_setting` ADD `space_mcp_servers` integer DEFAULT true NOT NULL;