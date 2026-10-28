CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`chance` real NOT NULL,
	`cooldown` integer NOT NULL,
	`enabled` integer NOT NULL,
	`scope` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
