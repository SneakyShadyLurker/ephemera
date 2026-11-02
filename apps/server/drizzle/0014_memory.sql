CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`cues` text NOT NULL,
	`turns` integer NOT NULL,
	`chapter_id` text,
	`pinned` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_characterId_seq_unique` ON `memories` (`character_id`,`seq`);--> statement-breakpoint
CREATE TABLE `memory_notebooks` (
	`character_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`situation` text NOT NULL,
	`facts` text NOT NULL,
	`threads` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `settings` ADD `memory_model` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `memory_reasoning` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `memory_span_tokens` integer DEFAULT 6000 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `memory_keep_turns` integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `memory_recap_tokens` integer DEFAULT 3000 NOT NULL;