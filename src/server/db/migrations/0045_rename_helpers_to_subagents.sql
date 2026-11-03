ALTER TABLE `helper` RENAME TO `subagent`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_subagent` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`parent_thread_id` text NOT NULL,
	`name` text NOT NULL,
	`instructions` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_subagent`("thread_id", "parent_thread_id", "name", "instructions", "archived_at", "created_at") SELECT "thread_id", "parent_thread_id", "name", "instructions", "archived_at", "created_at" FROM `subagent`;--> statement-breakpoint
DROP TABLE `subagent`;--> statement-breakpoint
ALTER TABLE `__new_subagent` RENAME TO `subagent`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `subagent_parent_idx` ON `subagent` (`parent_thread_id`,`created_at`);--> statement-breakpoint
UPDATE `thread_event` SET `type` = 'subagent.ended' WHERE `type` = 'helper.ended';--> statement-breakpoint
UPDATE `thread_event` SET `type` = 'subagent.limited' WHERE `type` = 'helper.limited';--> statement-breakpoint
UPDATE `thread_event` SET `data` = json_set(`data`, '$.to', 'agent') WHERE `type` = 'agent.message' AND json_extract(`data`, '$.to') = 'main';--> statement-breakpoint
UPDATE `thread_event` SET `data` = json_set(`data`, '$.value.sent', (SELECT json_group_array(CASE `value` WHEN 'main' THEN 'agent' ELSE `value` END) FROM json_each(`thread_event`.`data`, '$.value.sent'))) WHERE `type` = 'tool.ran' AND json_type(`data`, '$.value.sent') = 'array' AND EXISTS (SELECT 1 FROM `thread_event` AS `asked` WHERE `asked`.`thread_id` = `thread_event`.`thread_id` AND `asked`.`type` = 'tool.requested' AND json_extract(`asked`.`data`, '$.callId') = json_extract(`thread_event`.`data`, '$.callId') AND json_extract(`asked`.`data`, '$.toolId') = 'helpers.message');--> statement-breakpoint
UPDATE `org_tool_setting` SET `tool_id` = CASE `tool_id` WHEN 'helpers.message' THEN 'subagents.send' WHEN 'helpers.status' THEN 'subagents.list' ELSE 'subagents.' || substr(`tool_id`, 9) END WHERE `tool_id` IN ('helpers.start', 'helpers.message', 'helpers.status', 'helpers.wait', 'helpers.stop', 'helpers.archive');--> statement-breakpoint
UPDATE `space_tool_setting` SET `tool_id` = CASE `tool_id` WHEN 'helpers.message' THEN 'subagents.send' WHEN 'helpers.status' THEN 'subagents.list' ELSE 'subagents.' || substr(`tool_id`, 9) END WHERE `tool_id` IN ('helpers.start', 'helpers.message', 'helpers.status', 'helpers.wait', 'helpers.stop', 'helpers.archive');--> statement-breakpoint
UPDATE `org_toolset_setting` SET `toolset_id` = 'subagents' WHERE `toolset_id` = 'helpers';--> statement-breakpoint
UPDATE `space_toolset_setting` SET `toolset_id` = 'subagents' WHERE `toolset_id` = 'helpers';
