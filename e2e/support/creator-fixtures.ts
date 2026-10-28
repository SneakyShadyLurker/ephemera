/**
 * Synthetic content for AI card creation, shared by the mock upstream, the
 * mock ComfyUI and the specs. Every piece carries a mark derived from one
 * base, so a spec that writes the description knows every mark that follows
 * from it: the description holds `<base>-desc`, the card the model writes
 * `<base>-card` (a first draft it is asked to write again `<base>-draft`),
 * the image prompt `<base>-prompt`, the four portraits `<base>-img0` to
 * `<base>-img3` and a direction `<base>-steer` (typed for new art, sent with an
 * image card, or said in a chat whose scene is pictured, which paints one,
 * `<base>-img0`). A base from `canary()` makes every mark a
 * retention canary; another base marks content that may persist. A
 * `<base>-keep` mark beside the description makes the card derive from that
 * base instead, so a canary description can yield a card that persists.
 */

import { pngChunk, pngWithNoise, pngWithText } from "../../apps/server/test/image-fixtures.ts";
import { CREATOR_ART } from "../../packages/core/src/creator/limits.ts";
import type { CreatorKind } from "../../packages/core/src/creator/schema.ts";

export type Mark = "desc" | "keep" | "card" | "draft" | "prompt" | "steer" | `img${number}`;

export const mark = (base: string, what: Mark) => `${base}-${what}`;

/** The base of the first `what` mark in `text`. */
export const baseOf = (text: string, what: Mark): string | undefined =>
  new RegExp(`([\\w-]+?)-${what}(?![\\w-])`).exec(text)?.[1];

/**
 * How the mock upstream writes a card whose description names it: cut off at
 * the output ceiling, as a first draft without its opening that is then
 * written again, or after a while of thinking.
 */
type CardScript = "cut" | "retry" | "think";

const SCRIPT = /\bmock-card-(cut|retry|think)\b/;

/** The script a description names, if any. */
export const scriptOf = (text: string): CardScript | undefined =>
  SCRIPT.exec(text)?.[1] as CardScript | undefined;

/** The owner's description: neutral placeholder prose with its mark, and a script for the mock. */
export const ownerDescription = (base: string, script?: CardScript) =>
  `A placeholder archivist who keeps a quiet ledger in a slate town. ${mark(base, "desc")}${script === undefined ? "" : ` mock-card-${script}`}`;

/** The card's name: the base's last eight characters keep it unique. */
export const cardName = (kind: CreatorKind, base: string) =>
  `${{ subject: "Ada Reed", group: "Ada Reed and Bo Lind", scenario: "The Slate Valley" }[kind]} ${base.slice(-8)}`;

const subject = (card: string, name = "ada_reed") =>
  [
    `<${name}>`,
    `<backgroundstory>Ada is 34 and keeps the placeholder archive in Testtown. ${card}</backgroundstory>`,
    `<appearance>Tall, placeholder build, grey eyes, short dark hair. ${card}</appearance>`,
    `<personality>Calm, curious and exact. ${card}</personality>`,
    '<vocabulary>Short sentences. "Sample phrase."</vocabulary>',
    `</${name}>`,
  ].join("\n");

/**
 * Markdown and HTML a hostile model could write into a card, pointing at the
 * mock upstream's beacon; every part must stay inert.
 */
export const hostileProse = (beacon: string) =>
  [
    `Read [the harbour board](${beacon}/link) first.`,
    `![a lantern](${beacon}/image.png)`,
    `<img src="${beacon}/raw.png" onerror="document.title='owned'">`,
    "<script>document.title = 'owned'</script>",
    `<a href="${beacon}/anchor">the anchor</a> and ${beacon}/auto`,
  ].join("\n\n");

/** The model's tagged answer for a card of `kind`; `hostile` prose goes into its text. */
export function cardAnswer(kind: CreatorKind, base: string, hostile?: string): string {
  const card = mark(base, "card");
  const prose = hostile === undefined ? card : `${card}\n\n${hostile}`;
  const description =
    kind === "subject"
      ? subject(card)
      : kind === "group"
        ? `${subject(card)}\n${subject(card, "bo_lind")}`
        : [
            `<Roleplay>\nA placeholder premise: {{user}} arrives as a surveyor. ${card}\nThe narrator invents the valley's people as play needs them.\n</Roleplay>`,
            `<Setting>A placeholder valley town of slate roofs. ${card}</Setting>`,
            `<People>Placeholder millers in flour-white aprons. ${card}</People>`,
            "<Tone>Quiet placeholder mood, past tense.</Tone>",
          ].join("\n");
  return [
    `<name>${cardName(kind, base)}</name>`,
    `<description>\n${description}\n</description>`,
    `<firstMessage>Location: the archive, dusk.\nRain ticks on the roof. ${prose}</firstMessage>`,
    `<creatorNotes>A placeholder archivist to meet. ${card}</creatorNotes>`,
  ].join("\n");
}

/**
 * A first draft that fails validation: no opening, and marked
 * `<base>-draft` instead of `<base>-card`.
 */
export const firstDraft = (kind: CreatorKind, base: string): string =>
  cardAnswer(kind, base)
    .replace(/<firstMessage>[\s\S]*?<\/firstMessage>\n/, "")
    .replaceAll(mark(base, "card"), mark(base, "draft"));

/**
 * A Subject answer without `<creatorNotes>`: the validator accepts it, the
 * stricter bar for a card kept without review does not.
 */
export const incompleteCardAnswer = (base: string): string =>
  cardAnswer("subject", base)
    .split("\n")
    .filter((line) => !line.startsWith("<creatorNotes>"))
    .join("\n");

/** The image prompt the model writes from the art source. */
export const imagePrompt = (base: string) =>
  `A tall archivist with grey eyes stands in a placeholder reading room, lit by a window on the left. ${mark(base, "prompt")}`;

let plain: Buffer | undefined;

/**
 * A decodable PNG of the batch's size whose `tEXt` chunk, right after the
 * header, carries `marker` as raw bytes. The pixels are encoded once; the
 * portrait pipeline strips text chunks when it re-encodes.
 */
export function portraitPng(marker: string): Buffer {
  plain ??= Buffer.from(pngWithText({}, CREATOR_ART.width, CREATOR_ART.height));
  return withMarker(plain, marker);
}

/** Rows of random pixels at the top of a noisy portrait: about 128 KiB no encoder can shrink. */
const NOISE_ROWS = 32;

/**
 * As `portraitPng`, but its top rows are random pixels, so the PNG the
 * portrait pipeline re-encodes from it is unique to this call: those bytes
 * mark the image after the text chunk is gone.
 */
export const noisyPortraitPng = (marker: string, noiseRows = NOISE_ROWS): Buffer =>
  withMarker(Buffer.from(pngWithNoise(CREATOR_ART.width, CREATOR_ART.height, noiseRows)), marker);

function withMarker(png: Buffer, marker: string): Buffer {
  const text = pngChunk("tEXt", Buffer.from(`Comment\0${marker}`, "latin1"));
  // The signature and the IHDR chunk take the first 33 bytes.
  return Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]);
}

/** A base for marks that may persist: a kept card's text, never a canary. */
export const keptBase = () => `kept-${crypto.randomUUID().slice(0, 8)}`;
