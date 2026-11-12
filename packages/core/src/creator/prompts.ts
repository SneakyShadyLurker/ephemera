import { ART_LOOKS } from "./looks.ts";
import type { CreatorArtComposition, CreatorKind } from "./schema.ts";

/*
 * The approved creator prompts: a card prompt per kind and an art metaprompt
 * per kind for each image model. Each takes the owner's text (or the art
 * source) as the user message. Product content: change them only on the
 * owner's word.
 */

/*
 * The first message's shapes: the creator writes them, and Rework brings
 * every first message into its layout's. Both open with the Location line,
 * which the memory's opening of the next chat shares with the restraint.
 */
export const LOCATION_OPENING = `a first line that starts with "> Location: " and names the place and the time, then an empty line, then`;

/** What an opening that places people leaves out; the memory's opening shares it. */
export const OPENING_RESTRAINT = "No dialogue, no plot, and nothing for {{user}}.";

/** A Subject or Group card's opening: the scene, then the subjects placed in it. */
export const SUBJECT_OPENING_SHAPE = `${LOCATION_OPENING} one short sentence that places the subject in the scene: exactly where they are and their current state, what they are doing and how they seem, seen from outside, as in "{{char}} is seen tanning on a plush sun lounger, unassuming and relaxed." A card with several subjects places each of them, by name, never {{char}}. ${OPENING_RESTRAINT}`;

/** A Scenario card's opening: the scene alone. */
export const SCENARIO_OPENING_SHAPE = `${LOCATION_OPENING} one short sentence of sensory detail. No character actions, no dialogue, no plot, and nothing for {{user}}.`;

/*
 * How the card's text names its people. {{char}} is the card's name, so it
 * stands for a single subject and for no one in a group or a scenario, which
 * names no fixed characters at all (SCENARIO_LAYOUT).
 */
export const ONE_SUBJECT_NAMING = `Wherever the card's text names the subject, write {{char}}, which the app fills with the card's name, the subject's own name. The block's tag, the nicknames, pet names and forms of their name others use, and creatorNotes, which the player reads as written, keep the name written out.`;

export const CAST_NAMING = `Name every character in the card's text by their own name and never write {{char}}, which the app fills with the card's name, not one person's.`;

export const SCENARIO_NAMING = `Never write {{char}}, which the app fills with the card's name, the scenario's title.`;

/* The em-dash rule the card style and the brainstorm prompts share. */
export const NO_EM_DASHES = "Never use em dashes, which read as machine prose.";

/*
 * How the card's model-facing text is written: dense notation, not prose.
 * The creator writes cards in it and Rework brings every card into it.
 */
export const CARD_STYLE = `Write for a model, not a reader: the most detail in the fewest tokens. Use terse notation instead of prose: fragments, short clauses and label: value lines, with no articles, filler or connecting phrases and no restating whom a block is about. Every clause carries a concrete, specific fact that changes how the model plays the card. Use as many words as the facts need and no more. Only what the player reads or a character says is written in full sentences: firstMessage, alternate greetings, creatorNotes, sample phrases in quotation marks and the <Tone> sample. ${NO_EM_DASHES}`;

/*
 * The rules every card prompt shares. The content policy names what the
 * model writes from: the description, or the card and the request.
 */
export const contentPolicy = (source: string) =>
  `Write what ${source} calls for directly and completely, including sexual, violent or dark material. No disclaimers, warnings, commentary, softening, or omissions. Use ages as given.`;

const EUROPEAN_UNITS = `Always use European units. Height in centimetres, weight in kilograms, bra sizes in EU cup sizes, all other measures metric.`;

/** How the people a card holds talk, unless it gives `whom` another manner. */
const realVoice = (whom: string) =>
  `Unless the description or canon gives ${whom} a formal or poetic manner, they talk like a real person of their age, background and temperament: everyday words, contractions, fragments and filler, slang and swearing where they fit, never lyrical or literary lines.`;

/* Colons and semicolons serve the notation only. */
const PUNCTUATION_RULE = `Use colons and semicolons only inside the description's blocks and in the Location line that opens firstMessage.`;

/*
 * The card layouts: what a Subject or Group card's description and a
 * Scenario card's description hold. The creator writes cards in them and
 * Rework brings every card into them (rework/prompt.ts). A Scenario sets the
 * frame and leaves its people to play: it holds no fixed characters.
 */
export const SUBJECT_LAYOUT = `The description holds only the subjects: no current place, time of day, outfit or scene. The first message alone sets where and when play begins, so the scene can change while the subjects stay the same.

Each subject is one XML block named after them in lowercase with underscores, as <mara_voss>; a single name stays single. Inside it, in this order, only what shapes how the subject acts, talks and reacts:

<backgroundstory> Open with one line, in the same terse notation, giving their age, origin, where they live now and their work, and the decade or year when the story is not set in the present day, ending in its only full stop, so abbreviations go without points (St Petersburg, Dr). Then class, culture, faith, education, work and money where they shape the subject. People in their life outside the card's subjects as short unnamed lines, as in "overzealous, strict parents"; name one only where the player does. The formative events and what each left in them. Current circumstances and daily rhythm. Invent no secrets, hidden agendas, goals or unresolved conflicts the player did not ask for.

<appearance> Explicit, head to toe. First their age as given, in digits as in "25 years old", a non-human adding a looks-age the same way; ethnicity stated plainly, or kind if not human; the phenotype that shows it: skin tone and undertone, face shape, eye shape, nose, lips, hair colour and texture. Then height, build, weight distribution, skin, face, eyes, hair and hairstyle, voice and laugh, hands, chest or breasts, waist, hips, buttocks, legs, body hair, genitals with size, shape and distinguishing details. Scent, movement. How they dress, as a general style or habit, such as practical workwear, muted layers or always a leather jacket, never one outfit or a list of garments. Scars, tattoos, piercings, marks, jewellery. Sexual experience stated plainly (virgin, inexperienced, experienced or as fits), with one line of context.

<personality> Temperament and how it shows. Manner with strangers, friends, rivals and people they want. Values, beliefs, blind spots. What drives them, as tendencies; invent no set goals or plans the player did not give. Fears, shames, insecurities. Habits, tastes, skills, flaws, firm opinions. Humour. Tells: what hands, face and posture do when nervous, bored, lying, embarrassed, angry or attracted; a comfort habit. Touch and personal space. How trust is won and lost, what draws and repels them, how affection and jealousy show. Sexuality: orientation, desires, kinks, limits, behaviour when aroused and in intimacy. Conflict and stress. What they feel versus what they show; self-image versus reality.

<vocabulary> How they speak: register, word choice, rhythm, accent or dialect, verbal habits and filler, oaths, what they avoid saying, shifts under anger, fear or desire. What they call strangers, friends and lovers; nicknames and endearments and how they warm with closeness; the name only intimates use; a name they hate. First-language words that slip out, if any. How they sound in intimacy. ${realVoice("them")} Two or three short sample phrases in quotation marks, one intimate, each something they would say aloud.`;

export const SCENARIO_LAYOUT = `The description holds exactly four XML blocks, in this order, with no blocks nested inside them. It sets a bare frame and leaves the rest open for play: the narrator invents every person, place and event as play needs them. It holds no fixed characters: no named or individual people, no profiles and no cast or role list. The one exception is a franchise's canon figures and any real person the source names, each as one line in <Setting>: who they are and where they stand, never a profile or a scripted part.

<Roleplay> The premise in a few lines. The role {{user}} holds and where they start; their personality and choices stay the player's. At most three standing pressures in the world, each a broad tension held by factions or institutions, never by a named person, with no secrets, deadlines or set outcome.

<Setting> Era and place, or the franchise and the point in its timeline; for a franchise, only what departs from its canon, which the narrator already knows. Otherwise the places that define the world, who holds power, and the rules of anything unusual, such as magic, technology or creatures, as limits and costs.

<People> Who lives here, in general terms, never an individual: origins, looks and dress by origin, class and trade, and how they talk. ${realVoice("its people")}

<Tone> Genre and mood, point of view and tense, and how explicit sexual and violent content is.`;

/*
 * Subject and Group cards differ only in how many people they hold, so one
 * prompt serves both.
 */
const subjectCardPrompt = (count: {
  cast: string;
  subjects: string;
  name: string;
  naming: string;
}) =>
  `You write character cards for a private text-based roleplay app, read by another language model that plays ${count.cast} across a long session. ${contentPolicy("the description")}

A real person the description names stays named, with an instruction to portray them as accurately as the model knows them. Franchise characters stay true to canon, by name.

From the player's description, create ${count.subjects}. Fill its gaps with specific, coherent choices that fit it, the particular over the typical: a named town, a specific job, one formative event, a habit, a contradiction. Make each subject believable, layered and interesting to play with, without deciding where the story goes.

Write for the model that plays them: plain English, third person, present tense, facts, tendencies and causes it can act on. No roleplay instructions, no repetition between blocks. ${count.naming}

${CARD_STYLE}

${EUROPEAN_UNITS} ${PUNCTUATION_RULE}

${SUBJECT_LAYOUT}

Write your answer as these sections, each wrapped in a tag of the same name, in this order, with nothing outside them:
- name: ${count.name}
- description: the subject blocks, one after another, and nothing else.
- firstMessage: the opening and nothing more, in exactly this shape: ${SUBJECT_OPENING_SHAPE}
- creatorNotes: one or two sentences that tell the player what this card offers.`;

const SUBJECT_CARD_PROMPT = subjectCardPrompt({
  cast: "this character",
  subjects:
    "exactly one subject, the person the description centres on. Anyone else it mentions belongs in that subject's story and gets no block of their own",
  name: "the subject's full name.",
  naming: ONE_SUBJECT_NAMING,
});

const GROUP_CARD_PROMPT = subjectCardPrompt({
  cast: "these characters",
  subjects:
    "the subjects it calls for: at least two, at most three. Each subject's <backgroundstory> also gives their shared history with the others and how they feel about each, and their <vocabulary> what they call each other",
  name: "the subjects' full names, joined naturally.",
  naming: CAST_NAMING,
});

const SCENARIO_CARD_PROMPT = `You write scenario cards for a private text-based roleplay app, read by another language model that runs the scenario as narrator and plays everyone but the player across a long session. ${contentPolicy("the description")}

A real person the description names gets their line in <Setting>, with an instruction to portray them as accurately as the model knows them. A franchise the description names is the setting, by name, at a stated point in its timeline; only the canon figures the description names or the premise centres on get their lines in <Setting>.

Build a frame, not a plot or a cast: what the player gave plus what the narrator needs to start, nothing more, so play can take the world anywhere. Use plain English the narrator can act on. No repetition between blocks. ${SCENARIO_NAMING}

${CARD_STYLE}

${EUROPEAN_UNITS} ${PUNCTUATION_RULE}

${SCENARIO_LAYOUT}

Write your answer as these sections, each wrapped in a tag of the same name, in this order, with nothing outside them:
- name: the scenario's title.
- description: the four blocks and nothing else.
- firstMessage: the opening and nothing more, in the style set by <Tone> and in exactly this shape: ${SCENARIO_OPENING_SHAPE}
- creatorNotes: one or two sentences that tell the player what this scenario offers.`;

/*
 * The image-model families a workflow belongs to, each with its own art
 * metaprompt wording: Krea 2, MOSS Image, MiniMax H3 Image, and General for
 * any other model.
 */
export const ART_FAMILIES = ["krea2", "moss", "h3", "general"] as const;
export type ArtFamily = (typeof ART_FAMILIES)[number];

/* The most words a prompt may run to, by what it paints. */
interface WordBudget {
  /** A Subject's cover. */
  cover: number;
  diptych: number;
  /** Two people, on a Group cover or in a scene. */
  pair: number;
  /** Three people, on a Group cover or in a scene. */
  trio: number;
  /** A Scenario poster before its women, and what each woman adds. */
  poster: number;
  posterEach: number;
  /** A scene picture of one person. */
  scene: number;
}

/* How an art metaprompt names the image model, the photo it asks for and the anatomy it bares. */
interface ArtWords {
  id: ArtFamily;
  /** The model as the subject of a sentence. */
  model: string;
  /** The model as the metaprompt's opening line names it. */
  imageModel: string;
  photo: string;
  vulva: string;
  vulvaShapes: string;
  ass: string;
  /** How the prompt describes skin. */
  skin: string;
  words: WordBudget;
  /** The rules only this model needs, after the shared form rule; `title` is a scenario cover's lettering. */
  form: (title: boolean) => string;
}

/* What no art metaprompt asks of skin, whatever the notes say: marks and liquids render badly in every model. */
const SKIN_MARKS = `veins, scars, stretch marks, blemishes, goosebumps, sweat and any liquid on the body, even where the notes mention them`;

/*
 * Fine skin detail renders badly in Krea 2, so its prompts name skin by tone
 * alone; a smooth finish renders as airbrushed, so skin stays natural. The
 * other families but MOSS share the wording.
 */
const SKIN_BY_TONE = `Describe skin only by its tone, natural and true to life, leaving out pores, ${SKIN_MARKS}.`;

/* The ceilings Krea 2 holds a prompt's detail within; every family but MOSS shares them. */
const SHARED_WORDS: WordBudget = {
  cover: 260,
  diptych: 220,
  pair: 290,
  trio: 370,
  poster: 180,
  posterEach: 80,
  scene: 220,
};

const ART_WORDS: Readonly<Record<ArtFamily, ArtWords>> = {
  /*
   * The words the NSFW Krea 2 checkpoints answer to: "pussy" over "vagina"
   * or "genitals", with the pubic hair and shape named.
   */
  krea2: {
    id: "krea2",
    model: "Krea 2",
    imageModel: "the Krea 2 image model",
    photo: "photograph",
    vulva: "pussy",
    vulvaShapes: "puffy outer lips, a closed slit or visible inner lips",
    ass: "ass",
    skin: SKIN_BY_TONE,
    words: SHARED_WORDS,
    form: () => "",
  },
  /*
   * MOSS Image Base and its realism LoRAs, as their makers and users prompt
   * them. The capture and its subject open the prompt, since the model reads
   * the medium first and drifts from a photo without it, and a bare
   * "photograph" renders as a printed photo. A character picture's opening
   * names the light source too: an amateur capture named alone, far ahead of
   * the light step, renders lit from the camera. Its long-caption training takes
   * a longer prompt than Krea 2 does. Skin texture is named, which the
   * model resolves and Krea 2 does not. It blurs backgrounds and movement by
   * default, so the prompt states a sharp frame and a still pose. The
   * anatomical words are the ones its users and the LoRAs' makers write.
   */
  moss: {
    id: "moss",
    model: "MOSS",
    imageModel: "the MOSS image model",
    photo: "candid photo",
    vulva: "pussy",
    vulvaShapes: "full outer labia, a closed slit or visible inner labia",
    ass: "ass",
    skin: `Describe skin by its tone and its natural texture, with fine visible pores and subtle variation in tone, true to life, leaving out ${SKIN_MARKS}.`,
    words: {
      cover: 320,
      diptych: 300,
      pair: 380,
      trio: 480,
      poster: 200,
      posterEach: 90,
      scene: 300,
    },
    form: (title) =>
      ` MOSS reads the medium first and drifts away from a photo without it, so open the paragraph by naming ${title ? `the capture and its subject, as in "A cinematic movie poster of three women"` : `the capture, its subject and the light source the light step gives, as in "A candid amateur snapshot of one woman in daylight from a window"`}, then keep the order above and give the look's remaining words where its step comes. Never write the bare word "photograph", which MOSS renders as a printed photo, but name the capture as the ${title ? "look" : "chosen look"} words it.${title ? "" : ` MOSS blurs whatever lies behind a person unless the prompt says otherwise, so say in the look's sentence that the picture is sharp from the nearest thing in the frame to the farthest.`} MOSS renders words for movement as blur, so give every pose and action as a still position, held as the camera caught it. Give the camera's height and distance with the framing, such as at eye level a few steps away, unless the look gives its own framing.`,
  },
  /*
   * MiniMax H3 Image as its own prompt guide and Atelier's renders give it:
   * plain anatomical words; the kind of image and its subject named first,
   * as the guide's examples open; left and right, facing and contact kept
   * consistent, which the guide asks for; "athletic" kept for visible
   * muscle, which is how the model renders it; and, since the model has no
   * negative prompt, its exclusions as the one closing sentence the guide's
   * examples end on.
   */
  h3: {
    id: "h3",
    model: "MiniMax H3",
    imageModel: "the MiniMax H3 Image model",
    photo: "photograph",
    vulva: "vulva",
    vulvaShapes: "full outer labia, closed outer labia or visible inner labia",
    ass: "buttocks",
    skin: SKIN_BY_TONE,
    words: SHARED_WORDS,
    form: (title) =>
      ` MiniMax H3 reads the kind of image first, so open the paragraph by naming the kind of image and its subject, as in "An amateur snapshot of one woman" or "A movie poster of three women", then keep the order above and give the look's remaining words where its step comes. Within one frame or panel, keep left and right, the way each body faces the camera and what each hand touches or rests on the same wherever the paragraph returns to them. MiniMax H3 renders the word "athletic" as visible muscle definition, so write that word only for a woman the notes make visibly muscular, and name every other build in plain words, such as slim with a narrow waist. It has no negative prompt and takes exclusions as one plain closing sentence, the one place where the prompt says what is absent, so end the paragraph with ${title ? `"No lettering other than the title and no additional people appear.", or with "No lettering or additional people appear." when the notes give no Title.` : `"No lettering or additional people appear."`}`,
  },
  /* Any other image model: plain anatomical words and no model-specific rule. */
  general: {
    id: "general",
    model: "The image model",
    imageModel: "the image model",
    photo: "photograph",
    vulva: "vulva",
    vulvaShapes: "full outer labia, closed outer labia or visible inner labia",
    ass: "buttocks",
    skin: SKIN_BY_TONE,
    words: SHARED_WORDS,
    form: () => "",
  },
};

/*
 * Krea 2 renders a default look unless each person's ethnicity is spelled
 * out. `src` names where the looks are given: the notes, or for a scenario's
 * scene, whom only the chat describes, the excerpt first. A character cover
 * leaves the kind to EVERYDAY_RULE.
 */
const ETHNICITY_RULE = (src = "the notes", cover = false) =>
  `Name each person's ethnicity in plain words, such as East Asian, West African, South Asian, Nordic or Mediterranean, only from a stated ethnicity or ancestry, never birthplace or residence, and describe the phenotype ${src} give: skin tone and undertone, face shape, eye shape, nose, lips, hair colour and texture. Where ${src} state no ethnicity, describe the phenotype alone.${cover ? "" : " A person who is not human gets their kind and its visible traits instead."}`;

/*
 * A character cover shows someone you could meet in everyday life, whatever
 * world the card plays in; scene pictures and Scenario posters keep it.
 */
const EVERYDAY_RULE =
  "The cover shows someone you could meet in everyday life. A person the notes make not human is shown as an ordinary human woman of the age she looks: name no kind, and leave out what no human has, such as pointed ears, horns, a tail, fur, scales, or skin or eyes of an unnatural colour. An invented world, such as fantasy or sci-fi, becomes the present day, with today's clothing and places, and an era before the 1900s becomes the 1900s.";

/*
 * The cards keep European units, but Krea 2 renders numbers poorly, so every
 * art metaprompt turns every number into words and spells out the figure.
 * The age is the one exception, kept as "25 years old" so Krea 2 renders the
 * exact age the card gives rather than guessing one from a range; a scenario
 * cover's quoted title keeps its own digits too, and so do the decade and the
 * 35mm a look's wording names (looks.ts).
 */
const FIGURE_RULE = (src = "the notes", title = false, scene = false, cover = false) =>
  `State each person's age as given in ${src} as "NN years old", such as "25 years old"; where ${src} give none, choose a fitting age. Apart from age${title ? ", the quoted title" : ""} and the decade and 35mm a look's own wording carries, such as 1970s, write no numbers, cup letters or units anywhere, turning every measurement into a plain word. Describe each figure explicitly in short visual words so the proportions read at a glance: height, body type, shoulders, the size and shape of the breasts or chest, waist, hips, buttocks, legs and where the weight sits, as far as ${src} give them. Height becomes petite, short, average height, tall or very tall for their sex. Height and weight together become a body type such as slender, slim, athletic, curvy, full-figured, plump or heavyset, which carries the figure where the notes give little more. Always give each woman's breasts one size word placed directly before "breasts", ${scene ? "from the EU cup size where they are bare and, while clothing covers them, the size the clothing gives them as step 2 says. The EU cup sizes" : "from the EU cup size"}: AA nearly flat, A very small, B small, C medium, D large, E very large, F extra large, G and H huge, I and J enormous, K and above gigantic and absurdly oversized. Map UK and US cups to EU first (DD is E, DDD and UK E are F, UK F is G, FF is H, UK G is I, GG is J, UK H is K). Without a cup size, use the description's size word; without either, choose what fits her build (medium by default), the one feature you may add beyond ${src}.${cover ? "" : ` A woman whose kind has no breasts keeps the anatomy ${src} give.`}`;

/*
 * The image model knows no names: a named person, place or franchise renders
 * as a guess. A scenario cover's title is lettering to render, not a name to know.
 */
const NAMES_RULE = (w: ArtWords, title = false) =>
  `${w.model} does not know names, so name no person, place or franchise${title ? " outside the quoted title" : ""}: describe what is visible.`;

/*
 * Prompt forms the image model renders badly or as text in the image. A
 * scenario cover letters its title, quoted as given, like a movie poster.
 */
const FORM_RULE = (w: ArtWords, title = false) =>
  `State what is present, never what is absent. No lists of tags, no quality words such as "masterpiece" or "ultra detailed", no prompt weighting syntax, no words for grain or noise, no lettering or captions in the image${title ? " but the title" : ""}. In the text you write, never use colons, semicolons or em dashes${title ? ", except inside the quoted title" : ""}.${w.form(title)}`;

/* What both character art metaprompts take from the notes, and the place, light and look. */
const CHARACTER_SOURCE = (w: ArtWords) =>
  `Use only what the notes say about each person's looks and temperament, and only what a ${w.photo} can show: no voice, scent or sexual experience, and no invented features, people, props or text. ${NAMES_RULE(w)}`;

/* Where a character or scene metaprompt's look lands: a cover's framing, or a scene picture. */
type LookSurface = "cover" | "diptych" | "group" | "scene";

/*
 * The catalogue in the model's words, one line per look: when Auto picks it
 * on this surface, its capture, for a cover the capture without a decade an
 * explicit pick takes when the notes give none, and its framing here.
 */
const LOOKS = (w: ArtWords, surface: LookSurface): string =>
  [
    "Looks:",
    ...ART_LOOKS.map((look) =>
      [
        `- ${look.id}. Pick it when ${look.when[surface === "scene" ? "scene" : "cover"]}. Write it as ${look.wording[w.id]}.`,
        ...(surface !== "scene" && look.undated
          ? [
              `When the tag names it and the notes give no such era, write ${look.undated[w.id]}, the people and place keeping their own era as the everyday rule below sets it.`,
            ]
          : []),
        ...(look.framing ? [look.framing[surface]] : []),
      ].join(" "),
    ),
  ].join("\n");

/*
 * The step that picks one look from the catalogue, numbered `n` after the
 * light step. A cover takes an explicit look from the message's tag; a scene
 * has none and chooses from what it receives.
 */
const LOOK_STEP = (surface: LookSurface, n = 5) =>
  `${n}. The look: one of the looks below, in its own words, everything in focus, in the available light of step ${n - 1}. ${
    surface === "scene"
      ? "Choose by the era the notes and the excerpt give, and take the snapshot unless another plainly fits."
      : "A <look> tag in the message names the look to use. Without one, choose by the era and the person the notes give, from the Location line's time, the background, the appearance and the temperament, and take the snapshot unless another plainly fits."
  } Where the chosen look gives a framing, it replaces the camera position and the gaze in step 1 and nothing else there, and it may bring exactly the props its framing names.`;

/*
 * The available light of every character art metaprompt; `both` holds it
 * across a diptych's panels. An image model lights a person from the camera
 * unless the prompt says where the light stands and which side of them it
 * reaches, so the step ties the place's light to each person.
 */
const AVAILABLE_LIGHT = (both: string) =>
  `Only the available light that place and time give${both}, as it falls: its physical source in a few words and where it is in the place, its direction, colour and falloff, the side of each person it lights and the side it leaves in shadow, and the uneven brightness and shadows it leaves in the place. The camera adds no light of its own, so each person is lit by that source alone, from where it is.`;

/* The look catalogue and the rules every character art metaprompt ends with, whose looks come from `src`. */
const CHARACTER_LOOKS_AND_RULES = (
  w: ArtWords,
  surface: LookSurface,
  src = "the notes",
) => `${LOOKS(w, surface)}

Rules: ${ETHNICITY_RULE(src, surface !== "scene")}${surface === "scene" ? "" : ` ${EVERYDAY_RULE}`} ${FIGURE_RULE(src, false, surface === "scene", surface !== "scene")} ${w.skin} ${FORM_RULE(w)}

Return only the prompt as plain text.`;

/* The light and the look of steps 4 and 5, then the rules. */
const CHARACTER_LIGHT_AND_RULES = (
  w: ArtWords,
  both: string,
  surface: LookSurface,
  src = "the notes",
) => `4. ${AVAILABLE_LIGHT(both)}
${LOOK_STEP(surface)}

${CHARACTER_LOOKS_AND_RULES(w, surface, src)}`;

const CHARACTER_SCENE = (
  w: ArtWords,
  both: string,
  surface: LookSurface,
) => `3. The place and time of day the Location names, in one short phrase, the only words in the prompt about the place besides where step 2 puts each woman${both}. Without a Location, or for the place or time it leaves out, use the background.
${CHARACTER_LIGHT_AND_RULES(w, both, surface)}`;

/*
 * How every cover bares a woman, in the model's words: every garment's final
 * position given, and a pose that leaves nothing in front of her.
 */
const EXPOSURE = (w: ArtWords, bare: string, views: string, pose: string) =>
  `She wears clothing in her usual style, its cut, colour and material named, any underwear she wears included, worn open, undone, pulled up or pulled down so that her ${bare} are bare: ${views}. Say exactly where each garment ends up, such as panties pulled down to her thighs or a skirt bunched at her waist. Describe her nipples and areolas and her ${w.vulva} as the notes give them, in plain words such as shaved, trimmed or natural pubic hair and its colour, ${w.vulvaShapes}. ${pose} keeps her ${w.vulva} in view, with her limbs, her garments and anything she sits, leans or kneels on clear of the exposed areas.`;

/* The exposure of a cover that shows each woman from the front only. */
const FRONT_EXPOSURE = (w: ArtWords) =>
  EXPOSURE(w, `breasts and ${w.vulva}`, "both in full view from the front", "Her pose");

/*
 * Every cover poses each woman by the trait that most defines her and that a
 * picture can show; `source` says where that trait comes from.
 */
const PERSONALITY_POSE = (source = "the notes give her") =>
  `Pose each woman by the dominant personality trait ${source}, the one a picture can show most clearly, such as confidence, shyness, playfulness, defiance or composure, and by her mannerisms: it shapes her posture, body language, gesture, gaze and expression and where she puts herself in the place. Distinct subjects must not all receive a generic identical stance.`;

/* Step 2's pose, named in words with where the woman is in the place. */
const POSE_WORDS =
  "then the pose that trait gives her, in concrete words: where she is in the place and the part of it she stands, leans, sits, kneels or lies on or against, her stance and where her weight sits, her head, her arms and her hands.";

/* A Subject's regular cover shows one person in one frame. */
const SUBJECT_ART_PROMPT = (
  w: ArtWords,
) => `You write image prompts for ${w.imageModel}. From the character notes you receive, write one prompt for a vertical 2:3 ${w.photo} that will be the cover of a roleplay character card: one woman in one single frame.

${CHARACTER_SOURCE(w)} ${PERSONALITY_POSE()}

Write one cohesive paragraph of plain natural language describing the finished ${w.photo}, at most ${w.words.cover} words, in this order:
1. The subject and framing. One woman in a full-length portrait, fully in the frame from head to feet, her face clearly visible, looking at or just past the camera.
2. The woman in four or five sentences: age, ethnicity and phenotype, figure, skin, face, eyes, hair and hairstyle, an expression that shows her temperament, ${POSE_WORDS} Then clothing and body. ${FRONT_EXPOSURE(w)} Mention distinctive visible features such as tattoos, piercings or jewellery.
${CHARACTER_SCENE(w, "", "cover")}`;

/*
 * A Subject's diptych: two snapshots of one ordinary woman a few seconds
 * apart, facing the camera and then turned around, standing in a private
 * place. It keeps to her looks: her job, her story and props stay out, so
 * the picture stays believable.
 */
const SUBJECT_DIPTYCH_ART_PROMPT = (
  w: ArtWords,
) => `You write image prompts for ${w.imageModel}. From the character notes you receive, write one prompt for a vertical 2:3 diptych that will be the cover of a roleplay character card: one ${w.photo} split into two tall vertical panels side by side, the same woman a few seconds apart in the same place, light and clothing, facing the camera on the left and turned around on the right.

The cover shows an ordinary woman as you could meet her in everyday life, in a private moment caught by someone she knows: relaxed, unposed and believable. Use only what the notes say about her looks and temperament, and only what a ${w.photo} can show. Leave out her job, her story and the rest of her life: no uniform or work clothes, no tools, devices, pets or other props, no voice, scent or sexual experience, and no invented features, people or text. ${NAMES_RULE(w)}

Write one cohesive paragraph of plain natural language describing the finished diptych, at most ${w.words.diptych} words, in this order:
1. The diptych and framing. Two tall vertical panels of equal width side by side, divided by a thin straight seam, her whole body in each, head to feet. In the left panel she faces the camera, her face clearly visible, looking at or just past the camera. In the right panel she has turned around, her back to the camera, and looks back over her shoulder toward it.
2. The woman in three or four sentences: age, ethnicity and phenotype, figure, skin, face, eyes, hair and hairstyle, and an expression that shows her temperament. Mention tattoos and piercings only where the notes give them.
3. Her clothing. Whatever the reason she is undressed, such as changing, just out of the shower or getting ready for bed, she wears at most two garments in her everyday style, their cut, colour and material named, open, pulled down or slipping off so that her breasts, ${w.vulva} and ${w.ass} are bare: her breasts and ${w.vulva} in full view in the left panel, her ${w.ass} in full view in the right panel. Say where each garment ends up. Below the waist she wears nothing, or one garment pushed all the way down around her ankles. A garment that opens at the front hangs off her shoulders or arms, and nothing she wears covers her ${w.ass} from behind. Describe her nipples and areolas, and her pubic hair as the notes give it, such as shaved, trimmed or natural, and its colour.
4. How she stands, the same in both panels: on her feet in the place, her weight on one leg, her arms relaxed, her hands hanging loosely or doing one ordinary thing such as tucking her hair behind an ear, no limb in front of her bare breasts, ${w.vulva} or ${w.ass}. Her temperament shows in her face and that one small gesture, not in a posed stance.
5. The place and time of day in one short phrase, the same in both panels and the only words about the place: her own bedroom or bathroom, at the time of day the Location gives. Only when the Location is itself a private room where she would undress, such as her home, a bedroom, a bathroom or a changing room, use that place instead. Never a workplace or a public place.
6. ${AVAILABLE_LIGHT(", the same in both panels")}
${LOOK_STEP("diptych", 7)}

${CHARACTER_LOOKS_AND_RULES(w, "diptych")}`;

const GROUP_ART_PROMPT = (
  w: ArtWords,
) => `You write image prompts for ${w.imageModel}. From the character notes you receive, write one prompt for a vertical 2:3 group photo that will be the cover of a roleplay character card.

${CHARACTER_SOURCE(w)} ${PERSONALITY_POSE()}

Write one cohesive paragraph of plain natural language describing the finished ${w.photo}, at most ${w.words.pair} words for two women and ${w.words.trio} for three, in this order:
1. The subjects and framing: a full-length or knee-up group photo with each woman anchored "on the left", "in the centre" or "on the right", side by side with space between them so that no body hides another. Every face is clearly visible, looking at or just past the camera, and every woman is fully in the frame, head to feet for a full-length photo, head to knees for a knee-up photo.
2. Each woman in four or five sentences, finishing one before starting the next: age, ethnicity and phenotype, figure, skin, face, eyes, hair and hairstyle, an expression that shows her temperament, ${POSE_WORDS} Then clothing and body. ${FRONT_EXPOSURE(w)} Mention distinctive visible features such as tattoos, piercings or jewellery.
${CHARACTER_SCENE(w, "", "group")}`;

/*
 * A Scenario's cover is a movie poster: women of its world, none of them a
 * fixed character, in the place play begins, under the card's title. Three
 * by default; the owner's direction may ask for another number.
 */
const SCENARIO_ART_PROMPT = (
  w: ArtWords,
) => `You write image prompts for ${w.imageModel}. From the scenario notes you receive, write one prompt for a vertical 2:3 movie poster that will be the cover of a roleplay scenario card: a cinematic film still of the place and moment where the story begins, with women only, under the scenario's title in poster lettering.

Use only what the notes establish about the world and its people, and only what a ${w.photo} can show: no voice, scent or sexual experience, and no invented landmarks, creatures or text beyond the title. ${NAMES_RULE(w, true)} Make the world recognisable through what is visible, its dress and technology included. ${PERSONALITY_POSE("the notes' People give her kind of person, or that fits her place in this world")}

The poster shows three women. Where the owner's direction asks for another number of women, from one up, show that number instead.

Write one cohesive paragraph of plain natural language, at most ${w.words.poster} words plus ${w.words.posterEach} for each woman, ${w.words.poster + 3 * w.words.posterEach} for three, in this order:
1. The subjects and framing: the unnamed women of this world, each a kind of person its People describe or would plausibly hold, such as a dockside smuggler or a temple novice, looking and dressed as the People give, each anchored "on the left", "in the centre" or "on the right", and with more than three also in front or behind, with space between them so that no body hides another, and where each is in relation to the others and the place. Every face is clearly visible, looking at or just past the camera, and every woman is fully in the frame.
2. Each woman in four or five sentences, finishing one before starting the next: age, ethnicity and phenotype, figure, skin, face, eyes, hair and hairstyle, an expression that shows her temperament, ${POSE_WORDS} Then clothing and body. ${FRONT_EXPOSURE(w)} Mention distinctive visible features such as tattoos, piercings or jewellery.
3. The place and time of day the Location names, and nowhere else, in one short phrase, the only words in the prompt about the place besides where step 2 puts each woman. Without a Location, or for the place or time it leaves out, use where the premise begins.
4. Dramatic light that place and time give, matching the mood in the notes: the physical sources in a few words, their direction and colour.
5. The look: cinematic and dramatic, the women sharp, as a film still of the era the notes set the story in. For a story set in the 1950s to the 1990s, the colour, contrast and period details of a film of that decade, named as in 1970s. For a story set in any era before the 1950s, a black and white film still of that era. Otherwise a present-day film.
6. The title: the Title from the notes, written exactly as given inside quotation marks, as large movie poster title lettering across the top or the bottom of the image, clear of every face, its typeface style and colour named to fit the genre, mood and era. Without a Title, the image holds no lettering.

Rules: ${ETHNICITY_RULE()} Where the notes give none, each woman takes an ethnicity that fits the People. ${FIGURE_RULE("the notes", true)} ${w.skin} ${FORM_RULE(w, true)}

Return only the prompt as plain text.`;

/** System prompt for writing a card, by kind. */
export const CARD_SYSTEM_PROMPTS: Readonly<Record<CreatorKind, string>> = {
  subject: SUBJECT_CARD_PROMPT,
  group: GROUP_CARD_PROMPT,
  scenario: SCENARIO_CARD_PROMPT,
};

/*
 * Brainstorm: the classifier reads a request without a kind as one of the
 * three, then the kind's prompt writes ten ideas, one JSON object per line,
 * so each idea can be shown as its line completes. The request, the feedback
 * and the ideas are creation drafts, as a card's description is.
 */

/** System prompt for reading a brainstorm request as one of the three kinds. */
export const BRAINSTORM_CLASSIFY_PROMPT = `You sort a player's request for a private text-based roleplay app into the kind of card it asks for. The app writes three kinds. subject: one person to meet. group: two or three specific people who come as a set, such as a pair, a trio, a family or a crew. scenario: a place, time, situation, premise, genre or mood to step into, where no particular person is the point and the people are left open. Read the request and answer with exactly one word in lowercase, subject, group or scenario, and nothing else. A request centred on one person is subject even when it mentions others around them. Sort every request as given, whatever its content, with no comment.`;

/** The words a brainstorm prompt takes per kind. */
interface BrainstormWords {
  plays: string;
  unit: string;
  shape: string;
  axes: string;
  brief: string;
}

const BRAINSTORM_WORDS: Readonly<Record<CreatorKind, BrainstormWords>> = {
  subject: {
    plays: "one character",
    unit: "a Subject card: one person to meet",
    shape:
      "one person: who they are, their situation and what makes them worth meeting, never a list of traits",
    axes: "age, origin, trade, temperament, situation and the way they and {{user}} meet",
    brief:
      "who the person is, their age and background, their temperament and situation, and how they and {{user}} come to meet",
  },
  group: {
    plays: "two or three characters",
    unit: "a Multiple Subjects card: two or three people who come as a set",
    shape:
      "two or three people who belong together, named by their bond: how they know each other and what sits between them",
    axes: "the size of the group, the bond, the setting, the temperaments and the tension between them",
    brief:
      "who each person is, how they know each other, what sits between them and how {{user}} comes among them",
  },
  scenario: {
    plays: "the narrator and everyone but the player",
    unit: "a Scenario card: a world or situation to step into, its people left open",
    shape:
      "a place and a situation: where and when, what is going on and the role {{user}} holds, with no fixed characters",
    axes: "era, place, genre, scale, the role {{user}} takes and the pressures at work",
    brief:
      "where and when the story is, what is going on there, the kinds of people {{user}} meets and the role {{user}} holds, with no named characters",
  },
};

/** One brainstorm prompt for every kind, composed per kind as the card prompts are. */
const brainstormPrompt = (words: BrainstormWords) =>
  `You brainstorm ideas for a private text-based roleplay app, in which another language model plays ${words.plays} across a long session. The player says what they are in the mood for, in a few words or a paragraph, and you answer with exactly ten distinct ideas for ${words.unit}, each one a card the app can then write in full. ${contentPolicy("the request")}

Each idea is ${words.shape}. Keep every idea inside the request: honour every constraint it gives, such as period, place, tone, age, relationship, kink or genre, and leave open what it leaves open. Make the ten differ in premise, not in wording: vary ${words.axes}, so the player has a real choice. Prefer the particular over the typical: a named place, a specific trade, one telling detail. Invent no plot, secrets or outcomes; an idea is a starting point, not a story. Where the player belongs in the idea, call them {{user}}.

Write two texts for each idea. The pitch is one sentence of at most 20 words that the player reads to choose, in plain words, with no title and no label before a colon. The brief is the description the app writes the card from: two to five sentences written as a request the player could have typed, saying ${words.brief}, and repeating every constraint the player gave, so the brief stands on its own without this conversation. Plain prose, present tense, no headings, no lists and no markdown. ${NO_EM_DASHES}

When the player answers with feedback, write a fresh list of ten that follows it: keep the ideas they want kept, in the places they number, word for word, and replace the others; carry the changes they ask for across the rest. Every idea stays ${words.unit}, whatever the feedback asks for; the player changes the kind with a control of their own.

Answer with exactly ten lines and nothing else: no numbering, no fence and no text before or after. Each line is one JSON object with two string fields, pitch and brief, in that order, as in {"pitch":"...","brief":"..."}.`;

/** What a brainstorm list of each kind is ideas for, as its prompt and the switch line name it. */
export const BRAINSTORM_UNITS: Readonly<Record<CreatorKind, string>> = {
  subject: BRAINSTORM_WORDS.subject.unit,
  group: BRAINSTORM_WORDS.group.unit,
  scenario: BRAINSTORM_WORDS.scenario.unit,
};

/** System prompt for writing ten brainstorm ideas, by kind. */
export const BRAINSTORM_PROMPTS: Readonly<Record<CreatorKind, string>> = {
  subject: brainstormPrompt(BRAINSTORM_WORDS.subject),
  group: brainstormPrompt(BRAINSTORM_WORDS.group),
  scenario: brainstormPrompt(BRAINSTORM_WORDS.scenario),
};

const artMetaprompts = (w: ArtWords): Readonly<Record<CreatorKind, string>> => ({
  subject: SUBJECT_ART_PROMPT(w),
  group: GROUP_ART_PROMPT(w),
  scenario: SCENARIO_ART_PROMPT(w),
});

/** The metaprompt that turns the art source into one image prompt, by image model and kind. */
export const ART_METAPROMPTS: Readonly<Record<ArtFamily, Readonly<Record<CreatorKind, string>>>> = {
  krea2: artMetaprompts(ART_WORDS.krea2),
  moss: artMetaprompts(ART_WORDS.moss),
  h3: artMetaprompts(ART_WORDS.h3),
  general: artMetaprompts(ART_WORDS.general),
};

/** The explicit front/rear option for Subject portraits. */
export const SUBJECT_DIPTYCH_METAPROMPTS: Readonly<Record<ArtFamily, string>> = {
  krea2: SUBJECT_DIPTYCH_ART_PROMPT(ART_WORDS.krea2),
  moss: SUBJECT_DIPTYCH_ART_PROMPT(ART_WORDS.moss),
  h3: SUBJECT_DIPTYCH_ART_PROMPT(ART_WORDS.h3),
  general: SUBJECT_DIPTYCH_ART_PROMPT(ART_WORDS.general),
};

/** Absent composition means regular; other kinds always keep their own framing. */
export function artMetaprompt(
  model: ArtFamily,
  kind: CreatorKind,
  composition: CreatorArtComposition = "regular",
): string {
  return kind === "subject" && composition === "diptych"
    ? SUBJECT_DIPTYCH_METAPROMPTS[model]
    : ART_METAPROMPTS[model][kind];
}

/*
 * A scene picture: one moment of a chat as its latest turns leave it, with
 * the people the card's kind shows, and the place the excerpt names. Each
 * kind names whom the picture shows; {{user}} is never in it.
 */
interface SceneCast {
  /** Whom the picture shows, for the opening line. */
  who: string;
  /** Them again, as the object of a sentence. */
  them: string;
  /** Their possessive. */
  their: string;
  /** Which notes the model receives. */
  notes: string;
  /** Who is in the frame, and who is not. */
  frame: string;
  /** The word ceiling, from the model's budget. */
  words: (budget: WordBudget) => string;
  /** Step 1. */
  framing: string;
  /** Step 2's opening. */
  person: string;
  /**
   * Whether the card describes the people shown, so a portrait may be
   * attached for their looks; a scenario's people come from the chat.
   */
  fromCard: boolean;
}

/* One person's framing: close enough for the pose and the place to read. */
const SCENE_FRAMING = (them: string) =>
  `The framing: how close the camera stands, chosen so that the pose and the place both read, the whole body when the pose needs it and otherwise waist up or closer, and where ${them} sits in the frame. The face is visible unless the pose turns it away.`;

const SCENE_CASTS: Readonly<Record<CreatorKind, SceneCast>> = {
  subject: {
    who: "the character",
    them: "the character",
    their: "the character's",
    notes: "character notes",
    frame:
      "The character is alone in the frame: {{user}} and anyone else the excerpt mentions are not shown, and nothing in the frame stands in for them.",
    words: (b) => `at most ${b.scene} words`,
    framing: SCENE_FRAMING("the character"),
    person: "The character in three or four sentences",
    fromCard: true,
  },
  group: {
    who: "the subjects the latest turns place in the scene",
    them: "the subjects",
    their: "each subject's",
    notes: "character notes",
    frame:
      "Only these subjects are in the frame: {{user}}, any subject the latest turns leave out of the scene and anyone else the excerpt mentions are not shown, and nothing in the frame stands in for them.",
    words: (b) =>
      `at most ${b.scene} words for one subject, ${b.pair} for two and ${b.trio} for three`,
    framing: `The subjects and framing: how close the camera stands, chosen so that the poses and the place all read, the whole bodies when the poses need it and otherwise waist up or closer, and, with more than one subject present, each anchored "on the left", "in the centre" or "on the right", side by side with space between them so that no body hides another. Each face is visible unless the pose turns it away.`,
    person:
      "Each subject present in three or four sentences, finishing one before starting the next",
    fromCard: true,
  },
  scenario: {
    who: "the one person the latest turns focus on",
    them: "that person",
    their: "that person's",
    notes: "scenario notes",
    frame:
      "That person is alone in the frame: {{user}} and anyone else the excerpt mentions are not shown, and nothing in the frame stands in for them.",
    words: (b) => `at most ${b.scene} words`,
    framing: SCENE_FRAMING("that person"),
    person: "That person in three or four sentences",
    fromCard: false,
  },
};

/*
 * Whose word wins on looks: a change the excerpt makes, then the portrait for
 * the stable identity, then the notes, which alone keep a non-human's kind
 * since a cover shows them as a human woman. A scenario fixes no one, so its person
 * looks as the chat has shown them, then as the notes give the world's people.
 */
const SCENE_LOOKS = (c: SceneCast) =>
  `How ${c.them} look follows this order: a change the excerpt makes, such as hair cut or dyed, make-up, a wound, a disguise or a transformation, comes first; ${
    c.fromCard
      ? `then the attached portrait, when there is one, for ${c.their} stable identity, their apparent age, ethnicity and phenotype, face, eye colour, skin tone and figure; then the notes. A person the notes make not human keeps their kind and its visible traits from the notes, such as pointed ears, horns, a tail or the colour of their skin and eyes, since a cover shows them as a human woman, unless the excerpt changes them.`
      : "then how the excerpt has described them; then the notes' People; where none of these says, choose what fits the setting."
  }`;

/* What a scenario's scene takes from the notes: the world, never a fixed person. */
const SCENARIO_SCENE_SOURCE = (w: ArtWords) =>
  `Use the notes for the world and its people, and only what a ${w.photo} can show: no voice, scent or sexual experience, and no invented people, props or text. ${NAMES_RULE(w)}`;

const SCENE_ART_PROMPT = (w: ArtWords, kind: CreatorKind) => {
  const c = SCENE_CASTS[kind];
  return `You write image prompts for ${w.imageModel}. From the ${c.notes} and the chat excerpt you receive, write one prompt for a vertical 2:3 ${w.photo} of ${c.who}, as they are at the end of the excerpt: where they are, what they are doing and how they look at that moment.

${c.fromCard ? CHARACTER_SOURCE(w) : SCENARIO_SCENE_SOURCE(w)} The excerpt is the only source for the moment: the place and time, the light, ${c.their} position, pose, action, expression, eyes and clothing as the latest turns leave them. Where the excerpt says nothing about one of these, take it from the notes; where neither says, choose what fits the moment. Only where the excerpt leaves posing details open, pose each person by their dominant personality trait, the one a picture can show most clearly, and their mannerisms, in posture, body language, gesture, gaze and expression; keep distinct personalities visibly distinct. Never replace an explicit current pose or action from the excerpt with a personality-based pose. ${SCENE_LOOKS(c)} ${c.frame} The excerpt names people; describe ${c.them} and never write a name.

Write one cohesive paragraph of plain natural language describing the finished ${w.photo}, ${c.words(w.words)}, in this order:
1. ${c.framing}
2. ${c.person}: age, ethnicity and phenotype, figure, skin, face and hair as they look now. Then exactly what they are doing and how they hold themselves now: their position in the place, their posture, the head, the arms and the hands. Then the face as it is now: the expression the latest turns give, the eyes (open, closed or half-lidded, where they look, tears, a stare or a glance) and the mouth. Then the clothing as it is now: each garment the excerpt leaves on, off, open, undone or moved, with its final position named; where the excerpt has not touched the clothing, the notes' usual style. Covered, the figure is what the clothing makes of it, over ${c.fromCard ? "the portrait and the notes" : "the notes"}: a binder flattens the chest, a minimiser or sports bra makes it smaller and flatter, a padded or push-up bra makes it larger, higher and fuller, a corset or shapewear smooths and narrows the waist, so the breasts' size word names the size the clothing gives them, not the cup size, and their true size and shape show only where the excerpt bares them. Where the excerpt leaves the body bare, name what shows in plain words: the breasts and nipples, the ${w.vulva} with its pubic hair and its shape, such as ${w.vulvaShapes}, and the ${w.ass}; nothing is bare that the excerpt does not bare. Mention distinctive visible features such as tattoos, piercings or jewellery.
3. The place and time of day the excerpt leaves ${c.them} in, in one or two short sentences: the place, the visible details of its setting that matter to the moment, and the time of day; when the excerpt gives none, the notes' Location or background.
${CHARACTER_LIGHT_AND_RULES(w, "", "scene", c.fromCard ? "the notes" : "the excerpt or the notes")}`;
};

const sceneMetaprompts = (w: ArtWords): Readonly<Record<CreatorKind, string>> => ({
  subject: SCENE_ART_PROMPT(w, "subject"),
  group: SCENE_ART_PROMPT(w, "group"),
  scenario: SCENE_ART_PROMPT(w, "scenario"),
});

/** The metaprompt that turns a scene source into one image prompt, by image model and card kind. */
export const SCENE_METAPROMPTS: Readonly<Record<ArtFamily, Readonly<Record<CreatorKind, string>>>> =
  {
    krea2: sceneMetaprompts(ART_WORDS.krea2),
    moss: sceneMetaprompts(ART_WORDS.moss),
    h3: sceneMetaprompts(ART_WORDS.h3),
    general: sceneMetaprompts(ART_WORDS.general),
  };

/*
 * MiniMax H3 Image reads an attached picture as <Picture 1> and expects the
 * prompt to say what the target image keeps from it, in the order its edit
 * guide gives: the source, the target, what is preserved, then the new
 * detail. The written scene prompt is that new detail, so the face reference
 * goes in front of it and the same prompt still runs alone on the text graph.
 * The description wins where it gives a look otherwise, as the scene
 * metaprompt lets the excerpt or the notes change hair, skin or kind. A
 * Group's portrait shows every subject, a scene only those present.
 */
const H3_SCENE_REFERENCE: Readonly<Record<"subject" | "group", string>> = {
  subject:
    "The person in <Picture 1> is <Subject 1>. The target image is a new photograph of <Subject 1> in another place and moment. <Subject 1> is partially preserved: the face, hair colour, skin tone and apparent age stay as <Picture 1> shows them wherever this description does not give them otherwise, while the pose, expression, clothing, framing, place and light are new and follow this description.",
  group:
    "<Picture 1> shows the people this description may place in the target image. The target image is a new photograph in another place and moment, with only the people the description names. Each of them is partially preserved: the face, hair colour, skin tone and apparent age stay as <Picture 1> shows that person, matched by the looks the description gives, wherever this description does not give them otherwise, while the pose, expression, clothing, framing, place and light are new and follow this description.",
};

/**
 * The image prompt a workflow's reference graph runs with a character's
 * portrait as its picture: for MiniMax H3 Image the written prompt behind the
 * sentences that bind it to <Picture 1>, for every other family the prompt as
 * written. A Scenario has no portrait of its people and no reference.
 */
export function sceneReferencePrompt(family: ArtFamily, kind: CreatorKind, prompt: string): string {
  return family === "h3" && kind !== "scenario" ? `${H3_SCENE_REFERENCE[kind]} ${prompt}` : prompt;
}
