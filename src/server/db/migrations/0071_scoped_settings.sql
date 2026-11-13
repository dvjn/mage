-- What orgs and spaces set moves from a table each to one table per setting, a row being the org's
-- own while its space is null; a space's row names its org too.
CREATE TABLE `builtin_skill_setting` (
	`organization_id` text NOT NULL,
	`space_id` text,
	`key` text NOT NULL,
	`enabled` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `builtin_skill_setting_org_idx` ON `builtin_skill_setting` (`organization_id`,`key`) WHERE "builtin_skill_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `builtin_skill_setting_space_idx` ON `builtin_skill_setting` (`space_id`,`key`);--> statement-breakpoint
CREATE TABLE `tool_setting` (
	`organization_id` text NOT NULL,
	`space_id` text,
	`tool_id` text NOT NULL,
	`policy_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_id`) REFERENCES `tool_policy`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_setting_org_idx` ON `tool_setting` (`organization_id`,`tool_id`) WHERE "tool_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `tool_setting_space_idx` ON `tool_setting` (`space_id`,`tool_id`);--> statement-breakpoint
CREATE TABLE `toolset_option` (
	`organization_id` text NOT NULL,
	`space_id` text,
	`toolset_id` text NOT NULL,
	`option` text NOT NULL,
	`enabled` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `toolset_option_org_idx` ON `toolset_option` (`organization_id`,`toolset_id`,`option`) WHERE "toolset_option"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `toolset_option_space_idx` ON `toolset_option` (`space_id`,`toolset_id`,`option`);--> statement-breakpoint
CREATE TABLE `toolset_setting` (
	`organization_id` text NOT NULL,
	`space_id` text,
	`toolset_id` text NOT NULL,
	`enabled` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `toolset_setting_org_idx` ON `toolset_setting` (`organization_id`,`toolset_id`) WHERE "toolset_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `toolset_setting_space_idx` ON `toolset_setting` (`space_id`,`toolset_id`);--> statement-breakpoint
CREATE TABLE `artifact_setting` (
	`organization_id` text NOT NULL,
	`space_id` text,
	`public_allowed` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_setting_org_idx` ON `artifact_setting` (`organization_id`) WHERE "artifact_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_setting_space_idx` ON `artifact_setting` (`space_id`);--> statement-breakpoint
INSERT INTO `builtin_skill_setting` (`organization_id`, `space_id`, `key`, `enabled`) SELECT o.`organization_id`, NULL, o.`key`, o.`enabled` FROM `org_builtin_skill_setting` o;--> statement-breakpoint
INSERT INTO `builtin_skill_setting` (`organization_id`, `space_id`, `key`, `enabled`) SELECT s.`organization_id`, o.`space_id`, o.`key`, o.`enabled` FROM `space_builtin_skill_setting` o INNER JOIN `space` s ON s.`id` = o.`space_id`;--> statement-breakpoint
INSERT INTO `tool_setting` (`organization_id`, `space_id`, `tool_id`, `policy_id`) SELECT o.`organization_id`, NULL, o.`tool_id`, o.`policy_id` FROM `org_tool_setting` o WHERE o.`policy_id` IS NULL OR o.`policy_id` IN (SELECT `id` FROM `tool_policy`);--> statement-breakpoint
INSERT INTO `tool_setting` (`organization_id`, `space_id`, `tool_id`, `policy_id`) SELECT s.`organization_id`, o.`space_id`, o.`tool_id`, o.`policy_id` FROM `space_tool_setting` o INNER JOIN `space` s ON s.`id` = o.`space_id` WHERE o.`policy_id` IS NULL OR o.`policy_id` IN (SELECT `id` FROM `tool_policy`);--> statement-breakpoint
INSERT INTO `toolset_option` (`organization_id`, `space_id`, `toolset_id`, `option`, `enabled`) SELECT o.`organization_id`, NULL, o.`toolset_id`, o.`option`, o.`enabled` FROM `org_toolset_option` o;--> statement-breakpoint
INSERT INTO `toolset_option` (`organization_id`, `space_id`, `toolset_id`, `option`, `enabled`) SELECT s.`organization_id`, o.`space_id`, o.`toolset_id`, o.`option`, o.`enabled` FROM `space_toolset_option` o INNER JOIN `space` s ON s.`id` = o.`space_id`;--> statement-breakpoint
INSERT INTO `toolset_setting` (`organization_id`, `space_id`, `toolset_id`, `enabled`) SELECT o.`organization_id`, NULL, o.`toolset_id`, o.`enabled` FROM `org_toolset_setting` o;--> statement-breakpoint
INSERT INTO `toolset_setting` (`organization_id`, `space_id`, `toolset_id`, `enabled`) SELECT s.`organization_id`, o.`space_id`, o.`toolset_id`, o.`enabled` FROM `space_toolset_setting` o INNER JOIN `space` s ON s.`id` = o.`space_id`;--> statement-breakpoint
INSERT INTO `artifact_setting` (`organization_id`, `space_id`, `public_allowed`) SELECT o.`organization_id`, NULL, o.`public_allowed` FROM `artifact_org_setting` o;--> statement-breakpoint
INSERT INTO `artifact_setting` (`organization_id`, `space_id`, `public_allowed`) SELECT s.`organization_id`, o.`space_id`, o.`public_allowed` FROM `artifact_space_setting` o INNER JOIN `space` s ON s.`id` = o.`space_id`;--> statement-breakpoint
DROP TABLE `org_builtin_skill_setting`;--> statement-breakpoint
DROP TABLE `space_builtin_skill_setting`;--> statement-breakpoint
DROP TABLE `org_tool_setting`;--> statement-breakpoint
DROP TABLE `org_toolset_option`;--> statement-breakpoint
DROP TABLE `org_toolset_setting`;--> statement-breakpoint
DROP TABLE `space_tool_setting`;--> statement-breakpoint
DROP TABLE `space_toolset_option`;--> statement-breakpoint
DROP TABLE `space_toolset_setting`;--> statement-breakpoint
DROP TABLE `artifact_org_setting`;--> statement-breakpoint
DROP TABLE `artifact_space_setting`;