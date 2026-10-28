CREATE TABLE `persona_bindings` (
	`character_id` text PRIMARY KEY NOT NULL,
	`persona_id` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`blocks` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sampler_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sampler_values` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`model` text,
	`character_id` text,
	`persona_id` text,
	`default_persona_id` text,
	`prompt_preset_id` text,
	`sampler_preset_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`default_persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sampler_preset_id`) REFERENCES `sampler_presets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "settings_one_row" CHECK(`id` = 1)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_portraits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` text,
	`persona_id` text,
	`png` blob NOT NULL,
	`thumb` blob NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`version` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "portraits_one_owner" CHECK((`character_id` IS NULL) <> (`persona_id` IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_portraits`("character_id", "png", "thumb", "width", "height", "version") SELECT "character_id", "png", "thumb", "width", "height", "version" FROM `portraits`;--> statement-breakpoint
DROP TABLE `portraits`;--> statement-breakpoint
ALTER TABLE `__new_portraits` RENAME TO `portraits`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `portraits_characterId_unique` ON `portraits` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portraits_personaId_unique` ON `portraits` (`persona_id`);