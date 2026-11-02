import { z } from "zod";
import { modelIdSchema } from "../chat.ts";
import { creatorKindSchema, creatorReasoningSchema } from "../creator/schema.ts";
import { comfyuiWorkflowIdSchema } from "../settings.ts";
import { SCENE_LIMITS } from "./limits.ts";

/**
 * `POST /api/scene`: write an image prompt for the chat's current moment,
 * then paint one picture. Its events are the art stream's, with one image.
 */
export const sceneRequestSchema = z.strictObject({
  model: modelIdSchema,
  /** How long the model thinks before writing; absent, its default. */
  reasoning: creatorReasoningSchema,
  /** The workflow Settings chose, refused without a graph on the server; absent, the saved one. */
  workflow: comfyuiWorkflowIdSchema.optional(),
  /** The chat's character, whose portrait the server loads from the requester's own store. */
  characterId: z.uuid(),
  /** The card's kind as the tab read it; the server reads the stored card's own. */
  kind: creatorKindSchema,
  /** What `sceneSource` made in the tab: the notes, the names and the excerpt. Chat content. */
  source: z.string().trim().min(1).max(SCENE_LIMITS.sourceLength),
});
export type SceneRequest = z.infer<typeof sceneRequestSchema>;
