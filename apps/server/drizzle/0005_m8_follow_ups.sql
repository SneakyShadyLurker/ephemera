ALTER TABLE `settings` ADD `prefer_character_prompt` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `prefer_character_instructions` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- Prompt presets gain the lorebook wrapper; `{0}` sends the entries as they are.
UPDATE `prompt_presets` SET `formats` = json_set(`formats`, '$.lorebook', '{0}')
WHERE json_type(`formats`, '$.lorebook') IS NULL;
