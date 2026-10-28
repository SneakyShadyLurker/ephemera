import {
  CARD_LIMITS,
  type CardImportError,
  type CharacterCard,
  type ConversionReport,
  isNativeFileAttempt,
  parseCardText,
  serializeCharacter,
} from "@ephemera/core";
import { exportImage, ImageError, type ImageErrorCode, imageHeader, toPortrait } from "./images.ts";
import type { Portrait } from "./persistence/store.ts";
import { isPng, pngChunks, textChunk, withChunks } from "./png.ts";

/*
 * Card files: native PNG packets in `ephemera`, or foreign import-only
 * `ccv3`/`chara` chunks, all base64 of UTF-8 JSON, or a JSON file. Parsing the card is
 * packages/core's job; this module moves bytes in and out of PNGs.
 */

type CardFileError = CardImportError | ImageErrorCode;

type CardFileResult =
  | {
      ok: true;
      card: CharacterCard;
      portrait?: Portrait;
      report: ConversionReport;
    }
  | { ok: false; error: CardFileError; field?: string };

/** Base64 text longer than this cannot decode to a card within the JSON limit. */
const MAX_CHUNK_LENGTH = Math.ceil((CARD_LIMITS.cardJsonBytes * 4) / 3) + 4;

/**
 * The platform's base64 decoder: linear time, ASCII whitespace skipped,
 * padding optional, any other character refused. (A regular expression
 * check backtracked quadratically on long whitespace runs in card text.)
 */
function decodeChunk(base64: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.fromBase64(base64));
  } catch {
    return undefined;
  }
}

const CARD_KEYWORDS = ["ephemera", "ccv3", "chara"] as const;
type CardKeyword = (typeof CARD_KEYWORDS)[number];

/**
 * Reads the card's `tEXt` chunks by walking the PNG's chunk list, bounded by
 * the file size and never decompressing anything: a small card can carry
 * image data that inflates to gigabytes, and full decoders (fast-png's
 * included) inflate it all. sharp decodes the portrait later, bounded by the
 * header's pixel count. Metadata CRCs are not checked; malformed payloads
 * fail as cards instead.
 */
function pngCardText(
  bytes: Uint8Array,
): Partial<Record<CardKeyword, { text: string } | { error: "too_large" | "invalid" }>> {
  const found: Partial<Record<CardKeyword, { text: string } | { error: "too_large" | "invalid" }>> =
    {};
  for (const { type, data } of pngChunks(bytes) ?? []) {
    if (type === "tEXt") {
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const separator = buffer.indexOf(0);
      if (separator !== -1) {
        const keyword = buffer.toString("latin1", 0, separator);
        const known = CARD_KEYWORDS.find((k) => k === keyword);
        if (known === "ephemera" && found[known] !== undefined) {
          found[known] = { error: "invalid" };
        } else if (known !== undefined && found[known] === undefined) {
          found[known] =
            data.byteLength - separator - 1 > MAX_CHUNK_LENGTH
              ? { error: "too_large" }
              : { text: buffer.toString("latin1", separator + 1) };
        }
      }
    }
  }
  return found;
}

/**
 * Native presence owns dispatch and never falls back. For foreign-only PNGs,
 * a broken `ccv3` falls back to `chara`. The image itself is not checked here.
 */
export function pngCardJson(
  bytes: Uint8Array,
):
  | { ok: true; card: CharacterCard; json: string; report: ConversionReport }
  | { ok: false; error: CardFileError; field?: string } {
  const text = pngCardText(bytes);
  let failure: { ok: false; error: CardFileError; field?: string } | undefined;
  for (const keyword of CARD_KEYWORDS) {
    const chunk = text[keyword];
    if (chunk === undefined) continue;
    if ("error" in chunk) {
      if (keyword === "ephemera") return { ok: false, error: chunk.error };
      failure ??= { ok: false, error: chunk.error };
      continue;
    }
    const json = decodeChunk(chunk.text);
    if (keyword === "ephemera") {
      try {
        if (json === undefined || !isNativeFileAttempt(JSON.parse(json)))
          return { ok: false, error: "invalid" };
      } catch {
        return { ok: false, error: "invalid" };
      }
    }
    const parsed =
      json === undefined ? ({ ok: false, error: "not_json" } as const) : parseCardText(json);
    if (parsed.ok && json !== undefined) {
      return { ok: true, card: parsed.card, json, report: parsed.report };
    }
    if (!parsed.ok) {
      if (keyword === "ephemera") return parsed;
      failure ??= parsed;
    }
  }
  return failure ?? { ok: false, error: "not_a_card" };
}

async function readPngCard(bytes: Uint8Array): Promise<CardFileResult> {
  // Header first: a hostile size or a non-image is refused before anything else is read.
  await imageHeader(bytes);
  const result = pngCardJson(bytes);
  if (!result.ok) return result;
  return {
    ok: true,
    card: result.card,
    portrait: await toPortrait(bytes),
    report: result.report,
  };
}

/** Reads an uploaded card file. Never fetches anything a card points to. */
export async function readCardFile(bytes: Uint8Array): Promise<CardFileResult> {
  if (bytes.byteLength > CARD_LIMITS.uploadBytes) return { ok: false, error: "too_large" };
  try {
    if (isPng(bytes)) return await readPngCard(bytes);
  } catch (error) {
    if (error instanceof ImageError) return { ok: false, error: error.code };
    throw error;
  }
  if (bytes.byteLength > CARD_LIMITS.cardJsonBytes) return { ok: false, error: "too_large" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "not_a_card" };
  }
  return parseCardText(text);
}

const toBase64 = (text: string) => new TextEncoder().encode(text).toBase64();

/** A native PNG card, with exactly one Ephemera packet. */
export async function cardToPng(
  card: CharacterCard,
  portraitPng: Uint8Array | undefined,
): Promise<Uint8Array> {
  const image = await exportImage(portraitPng);
  const png = withChunks(image, [textChunk("ephemera", toBase64(serializeCharacter(card)))]);
  if (png === undefined) throw new ImageError("invalid_image");
  return png;
}
