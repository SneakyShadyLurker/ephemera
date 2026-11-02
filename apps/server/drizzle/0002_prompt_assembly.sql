ALTER TABLE `prompt_presets` ADD `formats` text DEFAULT '{"personality":"{{personality}}","scenario":"{{scenario}}","newChat":"[Start a new Chat]","newExampleChat":"[Example Chat]"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `context_windows` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- The context window is the model's own (CLIProxyAPI's catalog), no longer a sampler value.
UPDATE `sampler_presets` SET `sampler_values` = json_remove(`sampler_values`, '$.contextSize');