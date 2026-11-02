PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`blocks` text NOT NULL,
	`formats` text NOT NULL,
	`reasoning` text DEFAULT '{"autoParse":false,"tag":"think","addToPrompts":false,"maxAdditions":1}' NOT NULL,
	`authors_note` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_prompt_presets`("id", "name", "blocks", "formats", "reasoning", "authors_note", "revision", "created_at", "updated_at") SELECT "id", "name", "blocks", "formats", "reasoning", "authors_note", "revision", "created_at", "updated_at" FROM `prompt_presets`;--> statement-breakpoint
DROP TABLE `prompt_presets`;--> statement-breakpoint
ALTER TABLE `__new_prompt_presets` RENAME TO `prompt_presets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;