CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`nickname` text NOT NULL,
	`creator` text NOT NULL,
	`tags` text NOT NULL,
	`card` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portraits` (
	`character_id` text PRIMARY KEY NOT NULL,
	`png` blob NOT NULL,
	`thumb` blob NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
