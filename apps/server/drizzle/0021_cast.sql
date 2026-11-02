CREATE TABLE `cast_sheets` (
	`character_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`entries` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `cast_model` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `cast_reasoning` text;