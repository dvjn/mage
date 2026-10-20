CREATE TABLE `sign_in_attempt` (
	`state` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`code_verifier` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
