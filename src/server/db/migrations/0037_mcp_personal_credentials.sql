ALTER TABLE `mcp_credential` ADD `status` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_server` ADD `credentials` text DEFAULT 'shared' NOT NULL;