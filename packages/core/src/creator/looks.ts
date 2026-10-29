import type { ArtFamily } from "./prompts.ts";

/*
 * The capture looks a character cover or a scene picture can take, owned
 * once here and rendered into every character and scene art metaprompt. Each
 * is an amateur capture in the place's own available light: no text here
 * names flash, a studio or a staged shoot, and none uses a colon, semicolon
 * or the word stem MOSS renders as a printed photo, so a copied line keeps
 * the prompt's form rules. `<decade>` and `<the era>` are filled by the
 * metaprompt model from the notes.
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

/* The present-day amateur snapshot every metaprompt falls back to. */
const SNAPSHOT_WHEN =
  "the notes set the person or story in the 2010s to the present, or in an invented world the other looks do not fit, such as fantasy or sci-fi, its people in their own dress, caught as they stand";

/* Black and white covers every real era before colour film, centuries before cameras included. */
const MONOCHROME_WHEN = {
  cover:
    "the notes set the person or story in any real era before the 1950s, the 1940s and every earlier century included",
  scene:
    "the notes or the excerpt set the person or story in any real era before the 1950s, the 1940s and every earlier century included",
};

export const ART_LOOKS: readonly ArtLook[] = [
  {
    id: "snapshot",
    when: { cover: SNAPSHOT_WHEN, scene: SNAPSHOT_WHEN },
    wording: {
      krea2: "an amateur snapshot, raw and true to life",
      moss: "an amateur snapshot, raw and true to life",
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
      moss: "a candid smartphone selfie, raw and true to life",
      general: "a smartphone selfie, raw and true to life",
    },
    framing: {
      cover:
        "She stands full length before a large mirror, head to feet inside the glass, her phone raised in one hand to one side at about head height, her face clearly visible in the reflection, her eyes on the phone's screen. The reflection fills the frame and she is the only person in it.",
      diptych:
        "The left panel is her reflection filling a large mirror, her front toward it, her phone raised in one hand to one side at about head height, her face clearly visible in the glass. The right panel is the same moment from directly behind her, her real back at full height and her raised arm, the mirror further into the frame carrying her front reflected small. She is the only person in both panels and the reflection is her.",
      group:
        "One woman holds her phone raised at about head height before a large mirror, and every woman stands full length in the glass, head to feet, side by side with space between them, every face clearly visible in the reflection. The reflection fills the frame and these women are the only people in it.",
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
      moss: "a candid amateur 35mm colour film snapshot from the <decade>, the colours of that era's film in its dress and surroundings",
      general:
        "an amateur 35mm colour film snapshot from the <decade>, true to life, in that decade's colours, dress and surroundings",
    },
    undated: {
      krea2: "an amateur 35mm colour film snapshot, true to life",
      moss: "a candid amateur 35mm colour film snapshot",
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
        "an amateur snapshot from an early 2000s compact digital camera, true to life, in the crisp, bright colour of early digital and that decade's dress and surroundings",
      moss: "a candid amateur snapshot from an early 2000s compact digital camera, crisp, in the bright colour of early digital and that decade's dress and surroundings",
      general:
        "an amateur snapshot from an early 2000s compact digital camera, true to life, in the crisp, bright colour of early digital and that decade's dress and surroundings",
    },
    undated: {
      krea2:
        "an amateur snapshot from an early 2000s compact digital camera, true to life, in the crisp, bright colour of early digital",
      moss: "a candid amateur snapshot from an early 2000s compact digital camera, crisp, in the bright colour of early digital",
      general:
        "an amateur snapshot from an early 2000s compact digital camera, true to life, in the crisp, bright colour of early digital",
    },
  },
  {
    id: "monochrome",
    when: MONOCHROME_WHEN,
    wording: {
      krea2:
        "an amateur black and white film snapshot from <the era>, named as in the 1920s or the eighteenth century, true to life, in that era's dress and surroundings",
      moss: "a candid amateur black and white film snapshot from <the era>, named as in the 1920s or the eighteenth century, in that era's dress and surroundings",
      general:
        "an amateur black and white film snapshot from <the era>, named as in the 1920s or the eighteenth century, true to life, in that era's dress and surroundings",
    },
    undated: {
      krea2: "an amateur black and white film snapshot, true to life",
      moss: "a candid amateur black and white film snapshot",
      general: "an amateur black and white film snapshot, true to life",
    },
  },
];
