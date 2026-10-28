ALTER TABLE `settings` ADD `context_limits` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `trim_in_blocks` integer DEFAULT true NOT NULL;