-- One mode per tool, allow, ask or block, in place of the on/off switch and the levels per role. A
-- tool turned off is blocked; a space tool whose messagers or guests needed approval asks.
ALTER TABLE `org_tool_setting` ADD `mode` text NOT NULL DEFAULT 'allow';--> statement-breakpoint
UPDATE `org_tool_setting` SET `mode` = CASE WHEN `enabled` THEN 'allow' ELSE 'block' END;--> statement-breakpoint
ALTER TABLE `org_tool_setting` DROP COLUMN `enabled`;--> statement-breakpoint
ALTER TABLE `space_tool_setting` ADD `mode` text NOT NULL DEFAULT 'allow';--> statement-breakpoint
UPDATE `space_tool_setting` SET `mode` = CASE
	WHEN NOT `enabled` THEN 'block'
	WHEN `messager_level` = 'approve' OR `guest_level` = 'approve' THEN 'ask'
	ELSE 'allow'
END;--> statement-breakpoint
ALTER TABLE `space_tool_setting` DROP COLUMN `enabled`;--> statement-breakpoint
ALTER TABLE `space_tool_setting` DROP COLUMN `messager_level`;--> statement-breakpoint
ALTER TABLE `space_tool_setting` DROP COLUMN `guest_level`;
