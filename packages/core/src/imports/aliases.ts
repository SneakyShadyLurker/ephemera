import { EXAMPLE_SEPARATOR } from "../prompt/examples.ts";

/** Import/upgrade only. Apply solely to text actually expanded by the macro engine. */
export function normalizeMacroAliases(text: string): string {
  const aliases: Record<string, string> = {
    group: "char",
    groupnotmuted: "char",
    charifnotgroup: "char",
    notchar: "user",
    mesexamples: "exampleDialogue",
    mesexamplesraw: "exampleDialogue",
    charprompt: "characterSystemPrompt",
    charinstruction: "postHistoryInstructions",
    chardepthprompt: "characterNote",
    charcreatornotes: "creatorNotes",
    charversion: "characterVersion",
    charfirstmessage: "firstMessage",
  };
  return text
    .replace(/<(BOT|CHAR|USER|GROUP|CHARIFNOTGROUP)>/gi, (_, name: string) =>
      name.toUpperCase() === "USER" ? "{{user}}" : "{{char}}",
    )
    .replace(/\{\{\s*([a-z][\w-]*)\s*(?=\}\}|::)/gi, (match, name: string) =>
      Object.hasOwn(aliases, name.toLowerCase()) ? `{{${aliases[name.toLowerCase()]}` : match,
    )
    .replace(/\{\{\s*hasextension\s*::[^{}]*\}\}/gi, "false")
    .replace(
      /\{\{\s*(?:instruct(?:storystringprefix|storystringsuffix|userprefix|usersuffix|assistantprefix|assistantsuffix|separator|systemprefix|systemsuffix|firstassistantprefix|lastassistantprefix|firstuserprefix|lastuserprefix|stop|userfiller|systeminstructionprefix)|chatseparator|chatstart|charprefix|charnegativeprefix|charauthorsnote|defaultauthorsnote)\s*\}\}/gi,
      "",
    );
}

export const normalizeExampleDialogue = (text: string): string =>
  normalizeMacroAliases(text).replace(/<START>/gi, EXAMPLE_SEPARATOR);
