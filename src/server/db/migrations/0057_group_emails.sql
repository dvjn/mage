ALTER TABLE `scim_group` ADD `email` text;--> statement-breakpoint
ALTER TABLE `scim_group` ADD `email_key` text;--> statement-breakpoint
CREATE INDEX `scim_group_email_idx` ON `scim_group` (`email_key`);