ALTER TABLE `thread` ADD `org_access` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_guest` ADD `role` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_invite` ADD `role` text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact` ADD `org_role` text DEFAULT 'view' NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_person_share` ADD `role` text DEFAULT 'view' NOT NULL;