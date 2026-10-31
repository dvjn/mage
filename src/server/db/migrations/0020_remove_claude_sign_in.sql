-- The Claude sign-in is gone: its connections go with their credentials and model lists, and its
-- unfinished sign-ins. Threads and defaults that name its models fall back like any unavailable model.
DELETE FROM `credential` WHERE `connection_id` IN (SELECT `id` FROM `connection` WHERE `auth_kind` = 'claude');--> statement-breakpoint
DELETE FROM `connection_model` WHERE `connection_id` IN (SELECT `id` FROM `connection` WHERE `auth_kind` = 'claude');--> statement-breakpoint
DELETE FROM `connection` WHERE `auth_kind` = 'claude';--> statement-breakpoint
DELETE FROM `sign_in_attempt` WHERE `kind` = 'claude';
