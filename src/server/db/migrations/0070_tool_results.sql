-- What tool calls gave back moves out of the log where it is large: each such result to a row of its
-- own, its event saying its size in its place.
CREATE TABLE `tool_result` (
	`event_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `thread_event`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `tool_result` (`event_id`, `value`) SELECT `id`, `data` -> '$.value' FROM `thread_event` WHERE `type` = 'tool.ran' AND json_extract(`data`, '$.ok') AND length(`data` -> '$.value') > 16000;--> statement-breakpoint
UPDATE `thread_event` SET `data` = json_set(json_remove(`data`, '$.value'), '$.large', json_object('size', length(`data` -> '$.value'))) WHERE `id` IN (SELECT `event_id` FROM `tool_result`);
