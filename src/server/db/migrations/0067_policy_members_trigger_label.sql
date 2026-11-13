ALTER TABLE `thread_trigger` RENAME COLUMN "created_by" TO "created_by_label";--> statement-breakpoint
CREATE TABLE `tool_policy_member` (
	`policy_id` text NOT NULL,
	`role` text NOT NULL,
	`key` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`policy_id`, `role`, `key`),
	FOREIGN KEY (`policy_id`) REFERENCES `tool_policy`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `tool_policy_member` (`policy_id`, `role`, `key`, `position`) SELECT `tool_policy`.`id`, 'user', `each`.`value`, `each`.`key` FROM `tool_policy`, json_each(`tool_policy`.`users`) AS `each`;--> statement-breakpoint
INSERT OR IGNORE INTO `tool_policy_member` (`policy_id`, `role`, `key`, `position`) SELECT `tool_policy`.`id`, 'approver', `each`.`value`, `each`.`key` FROM `tool_policy`, json_each(`tool_policy`.`approvers`) AS `each`;--> statement-breakpoint
ALTER TABLE `tool_policy` DROP COLUMN `users`;--> statement-breakpoint
ALTER TABLE `tool_policy` DROP COLUMN `approvers`;