import type { PersonaFields } from "../persona.ts";
import type { ArtLookId } from "./looks.ts";
import { SCENARIO_BLOCKS, SUBJECT_TAGS } from "./parse.ts";
import type { CardProblem, CreatorKind } from "./schema.ts";

/*
 * The user message of a card request: the owner's description, and the
 * persona chosen when Create was pressed, so a description that speaks of
 * {{user}} is written around who the player is. The persona is context: the
 * card keeps calling the player {{user}}, since chat adds the persona's own
 * text and the card must stay usable with any persona.
 */

const PERSONA_NOTE =
  "The player plays {{user}} as the persona below. Treat it as part of the description: wherever the description or the card concerns {{user}}, keep it consistent with this persona. {{user}} is never one of the characters you write. Always call them {{user}}, never by the persona's name, and do not copy the persona into the card, because the roleplay supplies it separately.";

/** The user message for writing a card; without a persona, the description alone. */
export function cardPrompt(description: string, persona: PersonaFields | null): string {
  if (persona === null) return description;
  const about = persona.description.trim();
  return [
    PERSONA_NOTE,
    "",
    "<persona>",
    `<name>${persona.name}</name>`,
    ...(about === "" ? [] : [`<about>\n${about}\n</about>`]),
    "</persona>",
    "",
    `<player_description>\n${description}\n</player_description>`,
  ].join("\n");
}

/*
 * An image card's texts per kind. A Subject card reads one person; a Multiple
 * Subjects card and a Scenario read everyone shown, so they share the notes
 * and direction texts, which speak of people and the world.
 */
const IMAGE_CARD_SUBJECT_REQUEST =
  "Create the subject shown in the attached image. The image is the player's description. Read the person's apparent age, apparent ethnicity and phenotype, build, skin, face, eyes, hair and hairstyle, expression, visible marks, posture, setting and mood from it, and keep everything you write about their appearance consistent with what the image shows. Their clothing in it is one outfit: take from it only the general style it suggests, never the outfit itself. Fill in everything the image cannot show, such as name, origin, history, personality, sexuality and way of speaking, with specific, coherent choices that fit the person in the image.";

const IMAGE_CARD_GROUP_REQUEST =
  "Create the subjects shown in the attached image. The image is the player's description. Each person it shows is one subject, at most three; if it shows more, the three most prominent are the subjects and the others belong in their stories, and if it shows only one, that person is one of the subjects and you create the other. Read each person's apparent age, apparent ethnicity and phenotype, build, skin, face, eyes, hair and hairstyle, expression, visible marks and posture, and the setting and mood, from it, and keep everything you write about each person's appearance consistent with what the image shows. Each person's clothing in it is one outfit: take from it only the general style it suggests, never the outfit itself. Fill in everything the image cannot show, such as names, origins, histories, personalities, sexuality, ways of speaking and how they know each other, with specific, coherent choices that fit the people in the image.";

const IMAGE_CARD_SCENARIO_REQUEST =
  "Create the scenario this image opens onto. The image is the player's description. Its place, time, light and mood set the world and the opening Location, and the people it shows show who lives in this world: let their apparent origins, looks, dress, bearing and trades shape the kinds of people the card describes, without making any of them a named character. Add only what the frame needs and the image cannot show, such as the premise, the role of {{user}}, the world's rules and factions and the kinds of people who live there, with choices that fit the image.";

const IMAGE_CARD_SUBJECT_NOTES =
  "The notes below are the image prompt that produced this picture. Treat them as part of the description. Take any name, age, occupation, place, relationship or trait they state and build on it. Words about the camera, lens, film, lighting, framing or image style describe the photograph, not the person, so leave them out of the card. Where the notes and the image disagree about how the person looks, the image wins.";

/** The notes text for a Multiple Subjects card and a Scenario. */
const IMAGE_CARD_PEOPLE_NOTES =
  "The notes below are the image prompt that produced this picture. Treat them as part of the description. Take any name, age, occupation, place, relationship or trait they state and build on it. Words about the camera, lens, film, lighting, framing or image style describe the photograph, not the people or the world, so leave them out of the card. Where the notes and the image disagree about how someone looks, the image wins.";

/*
 * The owner's direction for an image card rides last, as the art direction
 * does: it outranks the notes and the choices the image leaves open, never
 * the image on looks or the system prompt's format.
 */
const IMAGE_CARD_SUBJECT_DIRECTION =
  "The owner's direction for this character follows. It is your primary direction: wherever it speaks, follow it before the notes and before any choice the image leaves open, such as name, age, origin, history, personality, sexuality and way of speaking, and treat what it adds as part of the description. Only where it contradicts what the image plainly shows about how the person looks does the image win, because the image is the card's portrait. The card's format, fields and rules stay exactly as the instructions say.";

/** The direction text for a Multiple Subjects card and a Scenario. */
const IMAGE_CARD_PEOPLE_DIRECTION =
  "The owner's direction for this card follows. It is your primary direction: wherever it speaks, follow it before the notes and before any choice the image leaves open, such as names, ages, origins, histories, personalities, sexuality, ways of speaking, the premise and the world, and treat what it adds as part of the description. Only where it contradicts what the image plainly shows about how someone looks does the image win, because the image is the card's portrait. The card's format, fields and rules stay exactly as the instructions say.";

const IMAGE_CARD_TEXTS: Record<CreatorKind, { request: string; notes: string; direction: string }> =
  {
    subject: {
      request: IMAGE_CARD_SUBJECT_REQUEST,
      notes: IMAGE_CARD_SUBJECT_NOTES,
      direction: IMAGE_CARD_SUBJECT_DIRECTION,
    },
    group: {
      request: IMAGE_CARD_GROUP_REQUEST,
      notes: IMAGE_CARD_PEOPLE_NOTES,
      direction: IMAGE_CARD_PEOPLE_DIRECTION,
    },
    scenario: {
      request: IMAGE_CARD_SCENARIO_REQUEST,
      notes: IMAGE_CARD_PEOPLE_NOTES,
      direction: IMAGE_CARD_PEOPLE_DIRECTION,
    },
  };

/**
 * The user message for writing a card of `kind` from an attached image: the
 * kind's request, then the notes and the owner's direction when given.
 */
export function imageCardPrompt(
  kind: CreatorKind,
  notes: string | null,
  direction: string | null,
): string {
  const texts = IMAGE_CARD_TEXTS[kind];
  return [
    texts.request,
    ...(notes === null ? [] : ["", texts.notes, "", "<notes>", notes, "</notes>"]),
    ...(direction === null
      ? []
      : ["", texts.direction, "", "<direction>", direction, "</direction>"]),
  ].join("\n");
}

/*
 * The owner's direction for new art rides in the user message after the
 * notes, so the approved metaprompt stays as it is and keeps the last word on
 * the prompt's form: the direction outranks the notes and the choices the
 * metaprompt leaves open, never its framing, order, length or rules.
 */
const ART_DIRECTION_NOTE =
  "The owner's direction for this image follows the notes. It is your primary direction: wherever it speaks, follow it before the notes and before any choice the instructions leave to you, such as the place, time of day, light, clothing, posture, expression or mood, and treat what it adds as part of the notes. A place or time of day it names replaces the Location's. Work it into the steps where it belongs, keeping everything each step requires. The framing, the order of the steps, the word limit, the rules and the plain-text answer stay exactly as the instructions say.";

/*
 * With the card's stored portrait attached, the look comes from the image and
 * the notes add what it cannot show. It rides before the direction note, so
 * the owner's direction still outranks both.
 */
const ART_REFERENCE_NOTE =
  "The attached image is the card's current portrait. Treat it as how the people in the notes look: take their apparent age, ethnicity and phenotype, face, eyes, hair and hairstyle, skin tone, figure and visible marks from the image, and their clothing too where the notes say nothing about it. Where the notes and the image disagree about how someone looks, the image wins. Take from the notes what the image cannot show, such as the age in years, the temperament, the place and the time of day. The image's own framing, camera, lens and light describe that photograph, not the one you write, so leave them out. The framing, the order of the steps, the word limit, the rules and the plain-text answer stay exactly as the instructions say.";

/*
 * An explicit look rides in the user message as a tag naming one of the
 * catalogue's looks, so each metaprompt stays one constant text per model,
 * kind and composition. It sits before the direction, which stays last.
 */
const ART_LOOK_NOTE =
  "The owner chose the look for this image. Use the look the <look> tag names from the instructions' list, in its own words, with the framing it gives, and keep everything else as the instructions say.";

/** The user message for writing an image prompt: the source, the reference note when a portrait is attached, the chosen look, then the direction. */
export function artPrompt(
  source: string,
  direction: string | null,
  reference = false,
  look: ArtLookId | null = null,
): string {
  return [
    source,
    ...(reference ? ["", ART_REFERENCE_NOTE] : []),
    ...(look === null ? [] : ["", ART_LOOK_NOTE, "", "<look>", look, "</look>"]),
    ...(direction === null
      ? []
      : ["", ART_DIRECTION_NOTE, "", "<direction>", direction, "</direction>"]),
  ].join("\n");
}

/** Tag names as a prose list: "<a>, <b> and <c>". */
const tagList = (names: readonly string[]): string => {
  const tags = names.map((name) => `<${name}>`);
  return `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`;
};

/** One problem of a rejected answer, in plain words for the model. */
function problemLine(problem: CardProblem): string {
  switch (problem.code) {
    case "missing":
      return `The <${problem.section}> section is missing or empty.`;
    case "incomplete":
      return `The <${problem.section}> section was opened and never closed.`;
    case "too_long":
      return `The <${problem.section}> section is longer than a card allows.`;
    case "subject_count": {
      const { count, min, max } = problem;
      const needed = min === max ? `exactly ${min}` : `${min} to ${max}`;
      return `The description holds ${count} subject blocks; it needs ${needed}.`;
    }
    case "block_name":
      return `The block <${problem.block}> is not named in lowercase letters joined by underscores.`;
    case "block_tags":
      return `The block <${problem.block}> does not hold ${tagList(SUBJECT_TAGS)} in that order, each closed, or is not closed itself.`;
    case "scenario_blocks":
      return `The description does not hold exactly the blocks ${tagList(SCENARIO_BLOCKS)}, in that order, each closed, with no character blocks inside them: a scenario card holds no fixed characters.`;
  }
}

/**
 * One part a card kept without review leaves empty, as
 * `incompleteForAutomaticKeep` names it: `creatorNotes`; a Scenario block
 * (`Roleplay`, `Setting`, `People` or `Tone`) when empty; or `<block>.<inner>` for
 * an empty inner block of a subject.
 */
function emptyLine(part: string): string {
  const [block, inner] = part.split(".");
  if (inner !== undefined) return `The <${inner}> block of <${block}> is empty.`;
  if (part === "creatorNotes") return `The <${part}> section is missing or empty.`;
  return `The <${part}> block is empty.`;
}

/**
 * The user turn after an answer that failed validation: what was wrong, and
 * a request for the whole card again in the required format. The rejected
 * answer goes before it as the assistant turn. `empty` adds what an image
 * card's stricter bar for an automatic keep still found empty.
 */
export function cardRetryPrompt(problems: CardProblem[], empty: string[] = []): string {
  return [
    "Your card does not follow the required format:",
    ...problems.map((problem) => `- ${problemLine(problem)}`),
    ...empty.map((part) => `- ${emptyLine(part)}`),
    "",
    "Write the whole card again, every section in the required order and format, with nothing outside the sections.",
  ].join("\n");
}
