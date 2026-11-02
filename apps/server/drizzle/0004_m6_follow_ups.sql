ALTER TABLE `prompt_presets` ADD `reasoning` text DEFAULT '{"autoParse":false,"tag":"think","addToPrompts":false,"maxAdditions":1}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `prompt_processing` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `reasoning_open` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `show_hidden_reasoning` integer DEFAULT false NOT NULL;