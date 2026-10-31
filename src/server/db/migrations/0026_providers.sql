DROP INDEX `connection_org_kind_idx`;--> statement-breakpoint
ALTER TABLE `connection` ADD `host` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `connection` ADD `settings` text;--> statement-breakpoint
UPDATE `connection` SET `host` = CASE WHEN `auth_kind` = 'codex' THEN 'codex' ELSE `provider` END;--> statement-breakpoint
UPDATE `connection` SET `auth_kind` = 'oauth' WHERE `auth_kind` = 'codex';--> statement-breakpoint
CREATE UNIQUE INDEX `connection_org_sign_in_idx` ON `connection` (`organization_id`,`host`) WHERE "connection"."auth_kind" = 'oauth';--> statement-breakpoint
ALTER TABLE `connection` DROP COLUMN `provider`;
