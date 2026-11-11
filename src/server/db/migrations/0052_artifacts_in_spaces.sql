CREATE TABLE `artifact_thread_use` (
	`artifact_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`artifact_id`, `thread_id`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_thread_use_thread_idx` ON `artifact_thread_use` (`thread_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`created_in_thread_id` text,
	`sharing` text DEFAULT 'space' NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `space`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_in_thread_id`) REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_artifact`("id", "space_id", "created_in_thread_id", "sharing", "version", "created_at", "updated_at") SELECT `artifact`.`id`, `thread`.`space_id`, `artifact`.`thread_id`, CASE `artifact`.`sharing` WHEN 'thread' THEN 'space' ELSE `artifact`.`sharing` END, `artifact`.`version`, `artifact`.`created_at`, `artifact`.`updated_at` FROM `artifact` INNER JOIN `thread` ON `thread`.`id` = `artifact`.`thread_id`;--> statement-breakpoint
ALTER TABLE `artifact_version` ADD `thread_id` text REFERENCES `thread`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
UPDATE `artifact_version` SET `thread_id` = (SELECT `artifact`.`thread_id` FROM `artifact` WHERE `artifact`.`id` = `artifact_version`.`artifact_id`);--> statement-breakpoint
INSERT INTO `artifact_thread_use`(`artifact_id`, `thread_id`) SELECT `id`, `thread_id` FROM `artifact` WHERE `id` IN (SELECT `id` FROM `__new_artifact`);--> statement-breakpoint
DROP TABLE `artifact`;--> statement-breakpoint
ALTER TABLE `__new_artifact` RENAME TO `artifact`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `artifact_space_idx` ON `artifact` (`space_id`,`updated_at`);