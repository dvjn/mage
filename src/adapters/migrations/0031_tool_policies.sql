-- Access policies in place of tool modes. Each org that had tools ask or need independent review
-- gets an org policy for each, which anyone who can edit the thread approves, as before; tools
-- that were allowed are set to nothing, which leaves them open, and blocked ones are off.
CREATE TABLE `tool_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`space_id` text,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`use` text NOT NULL,
	`users` text NOT NULL,
	`approvers` text NOT NULL,
	`independent` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tool_policy_organization_idx` ON `tool_policy` (`organization_id`);--> statement-breakpoint
INSERT INTO `tool_policy` (`id`, `organization_id`, `space_id`, `name`, `color`, `use`, `users`, `approvers`, `independent`)
SELECT `o`.`id` || '-sign-off', `o`.`id`, NULL, 'Sign-off', 'orange', 'none', '[]', '["editors"]', 0
FROM `organization` `o`
WHERE EXISTS (SELECT 1 FROM `org_tool_setting` `t` WHERE `t`.`organization_id` = `o`.`id` AND `t`.`mode` = 'ask')
	OR EXISTS (
		SELECT 1 FROM `space_tool_setting` `t` JOIN `space` `s` ON `s`.`id` = `t`.`space_id`
		WHERE `s`.`organization_id` = `o`.`id` AND `t`.`mode` = 'ask'
	);--> statement-breakpoint
INSERT INTO `tool_policy` (`id`, `organization_id`, `space_id`, `name`, `color`, `use`, `users`, `approvers`, `independent`)
SELECT `o`.`id` || '-independent-review', `o`.`id`, NULL, 'Independent review', 'violet', 'none', '[]', '["editors"]', 1
FROM `organization` `o`
WHERE EXISTS (SELECT 1 FROM `org_tool_setting` `t` WHERE `t`.`organization_id` = `o`.`id` AND `t`.`mode` = 'review')
	OR EXISTS (
		SELECT 1 FROM `space_tool_setting` `t` JOIN `space` `s` ON `s`.`id` = `t`.`space_id`
		WHERE `s`.`organization_id` = `o`.`id` AND `t`.`mode` = 'review'
	);--> statement-breakpoint
ALTER TABLE `org_tool_setting` ADD `policy_id` text REFERENCES `tool_policy`(`id`);--> statement-breakpoint
UPDATE `org_tool_setting` SET `policy_id` = CASE `mode`
	WHEN 'ask' THEN `organization_id` || '-sign-off'
	WHEN 'review' THEN `organization_id` || '-independent-review'
END;--> statement-breakpoint
DELETE FROM `org_tool_setting` WHERE `mode` = 'allow';--> statement-breakpoint
ALTER TABLE `org_tool_setting` DROP COLUMN `mode`;--> statement-breakpoint
ALTER TABLE `space_tool_setting` ADD `policy_id` text REFERENCES `tool_policy`(`id`);--> statement-breakpoint
UPDATE `space_tool_setting` SET `policy_id` = (
	SELECT `s`.`organization_id` FROM `space` `s` WHERE `s`.`id` = `space_tool_setting`.`space_id`
) || CASE `mode` WHEN 'ask' THEN '-sign-off' WHEN 'review' THEN '-independent-review' END;--> statement-breakpoint
DELETE FROM `space_tool_setting` WHERE `mode` = 'allow';--> statement-breakpoint
ALTER TABLE `space_tool_setting` DROP COLUMN `mode`;
