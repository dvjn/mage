ALTER TABLE `org_setting` ADD `title_model` text;--> statement-breakpoint
ALTER TABLE `thread` ADD `title_source` text;--> statement-breakpoint
UPDATE `thread` SET `title_source` = 'message' WHERE `title` IS NOT NULL;
