PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`palette` text DEFAULT 'lamplight' NOT NULL,
	`model` text,
	`character_id` text,
	`persona_id` text,
	`default_persona_id` text,
	`prompt_preset_id` text,
	`sampler_preset_id` text,
	`context_windows` text DEFAULT '{}' NOT NULL,
	`context_limits` text DEFAULT '{}' NOT NULL,
	`trim_in_blocks` integer DEFAULT true NOT NULL,
	`prompt_processing` text DEFAULT '{}' NOT NULL,
	`reasoning_open` integer DEFAULT false NOT NULL,
	`show_hidden_reasoning` integer DEFAULT false NOT NULL,
	`prefer_character_prompt` integer DEFAULT true NOT NULL,
	`prefer_character_instructions` integer DEFAULT true NOT NULL,
	`comfyui_base_url` text DEFAULT '' NOT NULL,
	`comfyui_workflow` text DEFAULT 'krea2-intorealism' NOT NULL,
	`memory_model` text,
	`memory_reasoning` text,
	`memory_span_tokens` integer DEFAULT 6000 NOT NULL,
	`memory_keep_turns` integer DEFAULT 4 NOT NULL,
	`memory_recap_tokens` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`default_persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sampler_preset_id`) REFERENCES `sampler_presets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "settings_one_row" CHECK(`id` = 1)
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "theme", "palette", "model", "character_id", "persona_id", "default_persona_id", "prompt_preset_id", "sampler_preset_id", "context_windows", "context_limits", "trim_in_blocks", "prompt_processing", "reasoning_open", "show_hidden_reasoning", "prefer_character_prompt", "prefer_character_instructions", "comfyui_base_url", "comfyui_workflow", "memory_model", "memory_reasoning", "memory_span_tokens", "memory_keep_turns", "memory_recap_tokens", "updated_at") SELECT "id", "theme", "palette", "model", "character_id", "persona_id", "default_persona_id", "prompt_preset_id", "sampler_preset_id", "context_windows", "context_limits", "trim_in_blocks", "prompt_processing", "reasoning_open", "show_hidden_reasoning", "prefer_character_prompt", "prefer_character_instructions", "comfyui_base_url", "comfyui_workflow", "memory_model", "memory_reasoning", "memory_span_tokens", "memory_keep_turns", NULL, "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;