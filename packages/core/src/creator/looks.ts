import type { ArtFamily } from "./prompts.ts";

/*
 * The capture looks a character cover or a scene picture can take, owned
 * once here and rendered into every character and scene art metaprompt. Each
 * is an amateur capture in the place's own available light: no text here
 * names flash, a studio or a staged shoot, and none uses a colon, semicolon
 * or the word stem MOSS renders as a printed photo, so a copied line keeps
 * the prompt's form rules. A snapshot's wording names no device and no
 * brightness: a compact camera or a phone beside the word snapshot renders
 * lit from the camera, so an era shows in its colour instead. MOSS's
 * wordings also name a sharp capture, since the model softens a frame whose
 * prompt does not. `<decade>` and `<the era>` are filled by the metaprompt
 * model from the notes.
 */

export const ART_LOOK_IDS = ["snapshot", "selfie", "film", "digital", "monochrome"] as const;
export type ArtLookId = (typeof ART_LOOK_IDS)[number];

export interface ArtLook {
  id: ArtLookId;
  /** When Auto picks it, as the clause after "Pick it when": on a cover, and in a scene picture. */
  when: { cover: string; scene: string };
  /** The capture in each model's words; opens the prompt's look. */
  wording: Readonly<Record<ArtFamily, string>>;
  /** An era look chosen outright for notes with no matching decade: the capture without one. */
  undated?: Readonly<Record<ArtFamily, string>>;
  /** Replaces step 1's camera position and gaze; absent keeps step 1. */
  framing?: { cover: string; diptych: string; group: string; scene: string };
}

/*
 * The present-day amateur snapshot every metaprompt falls back to. A cover
 * shows someone you could meet today, so it brings an invented world into
 * the present; a scene picture keeps the chat's world.
 */
const SNAPSHOT_WHEN = {
  cover:
    "the notes set the person or story in the 2010s to the present, or in an invented world such as fantasy or sci-fi, which the cover shows as the present day, its people in today's dress",
  scene:
    "the notes set the person or story in the 2010s to the present, or in an invented world the other looks do not fit, such as fantasy or sci-fi, its people in their own dress, caught as they stand",
};

/*
 * Black and white covers every real era before colour film. A cover stays in
 * the decades amateur snapshots existed, so an earlier era becomes the 1900s;
 * a scene picture keeps centuries before cameras.
 */
const MONOCHROME_WHEN = {
  cover:
    "the notes set the person or story in the 1900s to the 1940s, or in any earlier era, which the cover shows as the 1900s",
  scene:
    "the notes or the excerpt set the person or story in any real era before the 1950s, the 1940s and every earlier century included",
};

export const ART_LOOKS: readonly ArtLook[] = [
  {
    id: "snapshot",
    when: SNAPSHOT_WHEN,
    wording: {
      krea2: "an amateur snapshot, raw and true to life",
      moss: "a candid amateur snapshot, sharp, raw and true to life",
      h3: "an amateur snapshot, raw and true to life",
      general: "an amateur snapshot, raw and true to life",
    },
  },
  {
    id: "selfie",
    when: {
      cover:
        "the story is set in the present day and the background line, appearance or temperament make posting herself her life, as for an influencer, content creator, model or camgirl",
      scene: "the excerpt itself has her taking a picture of herself with her phone, and only then",
    },
    wording: {
      krea2: "a smartphone selfie, raw and true to life",
      moss: "a candid smartphone selfie, sharp, raw and true to life",
      h3: "a smartphone selfie, raw and true to life",
      general: "a smartphone selfie, raw and true to life",
    },
    framing: {
      cover:
        "She stands full length before a large mirror, head to feet inside the glass, her phone raised in one hand to one side at about head height, her face clearly visible in the reflection, her eyes on the phone's screen. The reflection fills the frame and she is the only person in it.",
      diptych:
        "Both panels are her reflection in a large mirror, head to feet inside the glass, her phone raised in one hand at about head height. In the left panel she faces the mirror, her face clearly visible in the glass, her eyes on the phone's screen. In the right panel she has turned her back to the mirror and looks over her shoulder at the phone's screen, her face clearly visible in profile. She is the only person in both panels.",
      group:
        "One subject holds her phone raised at about head height before a large mirror, and every subject stands full length in the glass, head to feet, side by side with space between them, every face clearly visible in the reflection. The reflection fills the frame and these subjects are the only people in it.",
      scene:
        "The capture the excerpt gives, her own phone held at arm's length or raised to a mirror.",
    },
  },
  {
    id: "film",
    when: {
      cover:
        "the notes set the person or story in the 1950s to the 1990s, by the background line, the Location line or the era of the clothing",
      scene: "the notes or the excerpt set the person or story in the 1950s to the 1990s",
    },
    wording: {
      krea2:
        "an amateur 35mm colour film snapshot from the <decade>, true to life, in that decade's colours, dress and surroundings",
      moss: "a candid amateur 35mm colour film snapshot from the <decade>, in sharp focus, the colours of that era's film in its dress and surroundings",
      h3: "an amateur 35mm colour film snapshot from the <decade>, true to life, in that decade's colours, dress and surroundings",
      general:
        "an amateur 35mm colour film snapshot from the <decade>, true to life, in that decade's colours, dress and surroundings",
    },
    undated: {
      krea2: "an amateur 35mm colour film snapshot, true to life",
      moss: "a candid amateur 35mm colour film snapshot, in sharp focus",
      h3: "an amateur 35mm colour film snapshot, true to life",
      general: "an amateur 35mm colour film snapshot, true to life",
    },
  },
  {
    id: "digital",
    when: {
      cover: "the notes set the person or story in the 2000s",
      scene: "the notes or the excerpt set the person or story in the 2000s",
    },
    wording: {
      krea2:
        "an amateur digital snapshot from the early 2000s, true to life, in the saturated colour of early digital and that decade's dress and surroundings",
      moss: "a candid amateur digital snapshot from the early 2000s, sharp, in the saturated colour of early digital and that decade's dress and surroundings",
      h3: "an amateur digital snapshot from the early 2000s, true to life, in the saturated colour of early digital and that decade's dress and surroundings",
      general:
        "an amateur digital snapshot from the early 2000s, true to life, in the saturated colour of early digital and that decade's dress and surroundings",
    },
    undated: {
      krea2: "an amateur digital snapshot, true to life, in the saturated colour of early digital",
      moss: "a candid amateur digital snapshot, sharp, in the saturated colour of early digital",
      h3: "an amateur digital snapshot, true to life, in the saturated colour of early digital",
      general:
        "an amateur digital snapshot, true to life, in the saturated colour of early digital",
    },
  },
  {
    id: "monochrome",
    when: MONOCHROME_WHEN,
    wording: {
      krea2:
        "an amateur black and white film snapshot from <the era>, named as in the 1920s, true to life, in that era's dress and surroundings",
      moss: "a candid amateur black and white film snapshot from <the era>, named as in the 1920s, in sharp focus, in that era's dress and surroundings",
      h3: "an amateur black and white film snapshot from <the era>, named as in the 1920s, true to life, in that era's dress and surroundings",
      general:
        "an amateur black and white film snapshot from <the era>, named as in the 1920s, true to life, in that era's dress and surroundings",
    },
    undated: {
      krea2: "an amateur black and white film snapshot, true to life",
      moss: "a candid amateur black and white film snapshot, in sharp focus",
      h3: "an amateur black and white film snapshot, true to life",
      general: "an amateur black and white film snapshot, true to life",
    },
  },
];
