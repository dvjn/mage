DROP INDEX `org_invite_org_idx`;--> statement-breakpoint
CREATE INDEX `org_invite_org_idx` ON `org_invite` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `member_org_role_idx` ON `member` (`organization_id`,`role`);