PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_portraits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` text,
	`persona_id` text,
	`thumb` blob NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`version` integer NOT NULL,
	`file` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "portraits_one_owner" CHECK((`character_id` IS NULL) <> (`persona_id` IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_portraits`("id", "character_id", "persona_id", "thumb", "width", "height", "version", "file") SELECT "id", "character_id", "persona_id", "thumb", "width", "height", "version", "file" FROM `portraits`;--> statement-breakpoint
DROP TABLE `portraits`;--> statement-breakpoint
ALTER TABLE `__new_portraits` RENAME TO `portraits`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `portraits_characterId_unique` ON `portraits` (`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portraits_personaId_unique` ON `portraits` (`persona_id`);--> statement-breakpoint
ALTER TABLE `lorebooks` ADD `counts` text DEFAULT '{}' NOT NULL;