-- Groups come from a SCIM directory now, for the whole server; orgs link them with a role. Org
-- members get their own role beside the one they have through groups.
CREATE TABLE `org_group` (
	`organization_id` text NOT NULL,
	`group_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`organization_id`, `group_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `scim_group`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `org_group_group_idx` ON `org_group` (`group_id`);--> statement-breakpoint
CREATE TABLE `scim_connection_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`connection_key` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`decommissioned_at` integer,
	`decommission_status` text DEFAULT 'active' NOT NULL,
	`decommission_cursor_user_id` text,
	`decommission_reconciled_user_count` integer DEFAULT 0 NOT NULL,
	`decommission_batch_count` integer DEFAULT 0 NOT NULL,
	`decommission_revision` integer DEFAULT 0 NOT NULL,
	`decommission_completed_at` integer,
	`decommission_lease_id` text,
	`decommission_lease_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connection_binding_connection_key_unique` ON `scim_connection_binding` (`connection_key`);--> statement-breakpoint
CREATE INDEX `scim_connection_binding_connection_idx` ON `scim_connection_binding` (`connection_id`);--> statement-breakpoint
CREATE TABLE `scim_group` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`display_name` text NOT NULL,
	`display_name_key` text NOT NULL,
	`external_id` text,
	`external_id_key` text,
	`order_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_display_name_key_unique` ON `scim_group` (`display_name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_external_id_key_unique` ON `scim_group` (`external_id_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_order_key_unique` ON `scim_group` (`order_key`);--> statement-breakpoint
CREATE INDEX `scim_group_connection_idx` ON `scim_group` (`connection_id`);--> statement-breakpoint
CREATE INDEX `scim_group_domain_idx` ON `scim_group` (`provisioning_domain_id`);--> statement-breakpoint
CREATE TABLE `scim_group_member` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`group_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`membership_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `scim_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scim_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_member_membership_key_unique` ON `scim_group_member` (`membership_key`);--> statement-breakpoint
CREATE INDEX `scim_group_member_connection_idx` ON `scim_group_member` (`connection_id`);--> statement-breakpoint
CREATE INDEX `scim_group_member_group_idx` ON `scim_group_member` (`group_id`);--> statement-breakpoint
CREATE INDEX `scim_group_member_scim_user_idx` ON `scim_group_member` (`scim_user_id`);--> statement-breakpoint
CREATE TABLE `scim_identity_tombstone` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_id_key` text NOT NULL,
	`user_id` text NOT NULL,
	`profile` text NOT NULL,
	`deleted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_identity_tombstone_external_id_key_unique` ON `scim_identity_tombstone` (`external_id_key`);--> statement-breakpoint
CREATE INDEX `scim_identity_tombstone_connection_idx` ON `scim_identity_tombstone` (`connection_id`);--> statement-breakpoint
CREATE INDEX `scim_identity_tombstone_domain_idx` ON `scim_identity_tombstone` (`provisioning_domain_id`);--> statement-breakpoint
CREATE INDEX `scim_identity_tombstone_user_idx` ON `scim_identity_tombstone` (`user_id`);--> statement-breakpoint
CREATE TABLE `scim_projection_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_value` text,
	`role` text NOT NULL,
	`grant_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scim_user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_projection_grant_grant_key_unique` ON `scim_projection_grant` (`grant_key`);--> statement-breakpoint
CREATE INDEX `scim_projection_grant_connection_idx` ON `scim_projection_grant` (`connection_id`);--> statement-breakpoint
CREATE INDEX `scim_projection_grant_domain_idx` ON `scim_projection_grant` (`provisioning_domain_id`);--> statement-breakpoint
CREATE INDEX `scim_projection_grant_scim_user_idx` ON `scim_projection_grant` (`scim_user_id`);--> statement-breakpoint
CREATE INDEX `scim_projection_grant_user_idx` ON `scim_projection_grant` (`user_id`);--> statement-breakpoint
CREATE TABLE `scim_subject` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_source_id` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_subject_user_id_unique` ON `scim_subject` (`user_id`);--> statement-breakpoint
CREATE INDEX `scim_subject_profile_source_idx` ON `scim_subject` (`profile_source_id`);--> statement-breakpoint
CREATE TABLE `scim_user` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connection_user_key` text NOT NULL,
	`user_name` text NOT NULL,
	`user_name_key` text NOT NULL,
	`primary_email` text NOT NULL,
	`work_email_value_index` text NOT NULL,
	`email_value_index` text NOT NULL,
	`display_name` text NOT NULL,
	`formatted_name` text NOT NULL,
	`given_name` text,
	`family_name` text,
	`serialized_emails` text NOT NULL,
	`serialized_attributes` text,
	`external_id` text,
	`external_id_key` text,
	`active` integer NOT NULL,
	`order_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_connection_user_key_unique` ON `scim_user` (`connection_user_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_user_name_key_unique` ON `scim_user` (`user_name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_external_id_key_unique` ON `scim_user` (`external_id_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_order_key_unique` ON `scim_user` (`order_key`);--> statement-breakpoint
CREATE INDEX `scim_user_connection_idx` ON `scim_user` (`connection_id`);--> statement-breakpoint
CREATE INDEX `scim_user_domain_idx` ON `scim_user` (`provisioning_domain_id`);--> statement-breakpoint
CREATE INDEX `scim_user_user_idx` ON `scim_user` (`user_id`);--> statement-breakpoint
DROP TABLE `group`;--> statement-breakpoint
DROP TABLE `group_member`;--> statement-breakpoint
ALTER TABLE `member` ADD `direct_role` text;--> statement-breakpoint
-- Every role so far was given to the member directly.
UPDATE `member` SET `direct_role` = `role`;--> statement-breakpoint
-- Roles in spaces given to the org-made groups go with them.
DELETE FROM `space_member` WHERE `subject_kind` = 'group';--> statement-breakpoint
-- A group's roles in spaces go when it leaves the directory.
CREATE TRIGGER `scim_group_space_roles` AFTER DELETE ON `scim_group` BEGIN
  DELETE FROM `space_member` WHERE `subject_kind` = 'group' AND `subject_id` = old.`id`;
END;
