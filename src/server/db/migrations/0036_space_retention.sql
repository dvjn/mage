-- Team orgs used to make every member a space of their own; those never written in go, and members
-- make one again where their org allows it. Personal orgs keep theirs.
DELETE FROM `space`
WHERE `kind` = 'personal'
	AND `organization_id` IN (SELECT `id` FROM `organization` WHERE `kind` = 'team')
	AND NOT EXISTS (SELECT 1 FROM `thread` `t` WHERE `t`.`space_id` = `space`.`id`);--> statement-breakpoint
ALTER TABLE `space` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `space` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `space` ADD `trashed_by` text REFERENCES user(id) ON UPDATE no action ON DELETE set null;
