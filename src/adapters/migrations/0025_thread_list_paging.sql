-- Thread lists paged, searched and narrowed in SQL: each thread keeps the text of its newest message
-- or reply to be found by, and indexes serve the order of a space's threads and the newest event of
-- each kind in a thread. Threads that already have messages take the text of the newest, with
-- line breaks and the commonest emphasis and code marks taken out.
DROP INDEX `thread_space_idx`;--> statement-breakpoint
ALTER TABLE `thread` ADD `last_message_text` text;--> statement-breakpoint
CREATE INDEX `thread_space_idx` ON `thread` (`space_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `thread_event_thread_type_idx` ON `thread_event` (`thread_id`,`type`,`seq`);--> statement-breakpoint
UPDATE `thread` SET `last_message_text` = (
	SELECT trim(replace(replace(replace(replace(replace(replace(replace(replace(
		group_concat(json_extract(p.`value`, '$.text'), ' '),
		char(10), ' '), char(13), ' '), char(9), ' '), '**', ''), '~~', ''), '`', ''), '  ', ' '), '  ', ' '))
	FROM `thread_event` e, json_each(e.`data`, '$.parts') p
	WHERE e.`id` = (
		SELECT e2.`id` FROM `thread_event` e2
		WHERE e2.`thread_id` = `thread`.`id` AND e2.`type` IN ('message', 'message.completed')
		ORDER BY e2.`seq` DESC LIMIT 1
	)
	AND json_extract(p.`value`, '$.type') = 'text'
);
