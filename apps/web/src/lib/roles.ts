import { type PromptRole, promptRoleSchema } from "@ephemera/core";
import { oneOf } from "./one-of.ts";
import { countOf } from "./text.ts";

/** Each message role's name in the UI. */
export const ROLE_NAMES: Record<PromptRole, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
};

/** Whether a select's value is a message role. */
export const isPromptRole = oneOf(promptRoleSchema.options);

/** Where a depth places a text in the chat: "after the latest message", "3 messages from the end". */
export const depthText = (depth: number): string =>
  depth === 0 ? "after the latest message" : `${countOf(depth, "message")} from the end`;
