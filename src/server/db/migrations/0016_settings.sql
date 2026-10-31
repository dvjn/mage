DROP INDEX `connection_org_kind_idx`;--> statement-breakpoint
ALTER TABLE `connection` ADD `label` text;--> statement-breakpoint
CREATE UNIQUE INDEX `connection_org_kind_idx` ON `connection` (`organization_id`,`provider`,`auth_kind`) WHERE "connection"."auth_kind" != 'api_key';--> statement-breakpoint
ALTER TABLE `org_setting` ADD `default_effort` text;--> statement-breakpoint
ALTER TABLE `space` ADD `default_model` text;--> statement-breakpoint
ALTER TABLE `space` ADD `default_effort` text;