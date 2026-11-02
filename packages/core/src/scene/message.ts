/*
 * With the card's stored portrait attached, the people's stable looks come
 * from it; what the excerpt changes still wins, and nothing else of the
 * photograph enters the scene.
 */
export const SCENE_REFERENCE_NOTE =
  "The attached image is the card's current portrait. Take each person's stable identity from it: their apparent age, ethnicity and phenotype, face, eye colour, hair, skin tone, figure and visible marks. Where the notes and the image disagree about how someone looks, the image wins, but a change the excerpt makes to their looks, such as hair cut or dyed, make-up, a wound, a disguise or a transformation, wins over the image. Take nothing else from it: its clothing, pose, expression, place, light, framing and camera describe that photograph, not this moment, which the excerpt gives. The framing, the order of the steps, the word limit, the rules and the plain-text answer stay exactly as the instructions say.";

/** The user message for a scene's image prompt: the source, then the reference note when a portrait is attached. */
export function scenePrompt(source: string, reference: boolean): string {
  return reference ? [source, "", SCENE_REFERENCE_NOTE].join("\n") : source;
}
