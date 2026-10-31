CREATE TABLE `connection_model` (
	`connection_id` text NOT NULL,
	`model_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `model_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `connection` ADD `auto_enable_models` integer DEFAULT true NOT NULL;