-- Prompt presets gain the continue nudge, the impersonation prompt and the continue postfix, with Ephemera's defaults.
UPDATE `prompt_presets` SET `formats` = json_set(
  `formats`,
  '$.continueNudge', '[Your last message was cut off. Continue it from the exact word where it stops, without repeating or restating anything already written.]',
  '$.impersonation', '[Write {{user}}''s next message in this roleplay, in {{user}}''s voice and style as the chat so far shows it. Write only {{user}}''s words and actions, never {{char}}''s or a narrator''s.]',
  '$.continuePostfix', ' '
) WHERE json_type(`formats`, '$.continueNudge') IS NULL;
