INSERT INTO `thread_watch` (`id`, `thread_id`, `owner_id`, `kind`, `until`, `created_at`) SELECT `id`, `thread_id`, `owner_id`, 'tasks', `until`, `created_at` FROM `thread_task_watch`;--> statement-breakpoint
INSERT OR IGNORE INTO `thread_watch_subject` (`watch_id`, `subject_id`) SELECT `thread_task_watch`.`id`, `task`.`value` FROM `thread_task_watch`, json_each(`thread_task_watch`.`task_ids`) AS `task`;--> statement-breakpoint
DROP TABLE `thread_task_watch`;
