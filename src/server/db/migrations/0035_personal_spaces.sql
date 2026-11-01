-- Members' own spaces in team orgs are opt-in from here on: a team org without a setting stored
-- starts off. Every existing team org keeps what it had, which before this was on unless an owner
-- turned it off, so those with nothing stored get it stored on first.
INSERT INTO `org_setting` (`organization_id`, `member_spaces`)
SELECT `o`.`id`, 1 FROM `organization` `o`
WHERE `o`.`kind` = 'team'
	AND NOT EXISTS (SELECT 1 FROM `org_setting` `s` WHERE `s`.`organization_id` = `o`.`id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_org_setting` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`default_model` text,
	`title_model` text,
	`default_effort` text,
	`space_creation` text DEFAULT 'members' NOT NULL,
	`member_spaces` integer DEFAULT false NOT NULL,
	`space_mcp_servers` integer DEFAULT true NOT NULL,
	`space_skills` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_org_setting`("organization_id", "default_model", "title_model", "default_effort", "space_creation", "member_spaces", "space_mcp_servers", "space_skills", "created_at", "updated_at") SELECT "organization_id", "default_model", "title_model", "default_effort", "space_creation", "member_spaces", "space_mcp_servers", "space_skills", "created_at", "updated_at" FROM `org_setting`;--> statement-breakpoint
DROP TABLE `org_setting`;--> statement-breakpoint
ALTER TABLE `__new_org_setting` RENAME TO `org_setting`;--> statement-breakpoint
PRAGMA foreign_keys=ON;