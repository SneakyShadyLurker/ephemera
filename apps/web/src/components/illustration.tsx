import type { CSSProperties } from "react";
import createGroupDay from "@/assets/illustrations/create-group-day.webp";
import createGroupNight from "@/assets/illustrations/create-group-night.webp";
import createScenarioDay from "@/assets/illustrations/create-scenario-day.webp";
import createScenarioNight from "@/assets/illustrations/create-scenario-night.webp";
import createSubjectDay from "@/assets/illustrations/create-subject-day.webp";
import createSubjectNight from "@/assets/illustrations/create-subject-night.webp";
import emptyCharactersDay from "@/assets/illustrations/empty-characters-day.webp";
import emptyCharactersNight from "@/assets/illustrations/empty-characters-night.webp";
import emptyChatDay from "@/assets/illustrations/empty-chat-day.webp";
import emptyChatNight from "@/assets/illustrations/empty-chat-night.webp";
import emptyLibraryDay from "@/assets/illustrations/empty-library-day.webp";
import emptyLibraryNight from "@/assets/illustrations/empty-library-night.webp";
import emptyMemoryDay from "@/assets/illustrations/empty-memory-day.webp";
import emptyMemoryNight from "@/assets/illustrations/empty-memory-night.webp";
import emptyPersonasDay from "@/assets/illustrations/empty-personas-day.webp";
import emptyPersonasNight from "@/assets/illustrations/empty-personas-night.webp";
import errorDay from "@/assets/illustrations/error-day.webp";
import errorNight from "@/assets/illustrations/error-night.webp";
import notFoundDay from "@/assets/illustrations/not-found-day.webp";
import notFoundNight from "@/assets/illustrations/not-found-night.webp";
import { cn } from "@/lib/cn";

type Piece = {
  /** Width over height, as CSS writes it. */
  ratio: "4 / 3" | "1 / 1";
  /** Where the lamp's flame sits, as fractions of the image; none when the lamp is out. */
  lamp: readonly [x: number, y: number] | null;
  /** The ink-on-paper print, its ink white (the day scheme). */
  day: string;
  /** The engraving's lit lines (the night scheme). */
  night: string;
};

/**
 * The engraved set, one entry per piece: its files (bundled, so hashed and
 * same-origin; a file loads only where its piece is shown), its shape and
 * its lamp.
 */
const ILLUSTRATIONS = {
  "empty-chat": { ratio: "4 / 3", lamp: [0.63, 0.58], day: emptyChatDay, night: emptyChatNight },
  "empty-characters": {
    ratio: "4 / 3",
    lamp: [0.57, 0.46],
    day: emptyCharactersDay,
    night: emptyCharactersNight,
  },
  "empty-personas": {
    ratio: "4 / 3",
    lamp: [0.81, 0.3],
    day: emptyPersonasDay,
    night: emptyPersonasNight,
  },
  "empty-library": {
    ratio: "4 / 3",
    lamp: [0.77, 0.38],
    day: emptyLibraryDay,
    night: emptyLibraryNight,
  },
  "empty-memory": {
    ratio: "4 / 3",
    lamp: [0.72, 0.37],
    day: emptyMemoryDay,
    night: emptyMemoryNight,
  },
  "not-found": { ratio: "4 / 3", lamp: null, day: notFoundDay, night: notFoundNight },
  error: { ratio: "4 / 3", lamp: [0.56, 0.57], day: errorDay, night: errorNight },
  "create-subject": {
    ratio: "1 / 1",
    lamp: [0.67, 0.41],
    day: createSubjectDay,
    night: createSubjectNight,
  },
  "create-group": {
    ratio: "1 / 1",
    lamp: [0.5, 0.61],
    day: createGroupDay,
    night: createGroupNight,
  },
  "create-scenario": {
    ratio: "1 / 1",
    lamp: [0.33, 0.58],
    day: createScenarioDay,
    night: createScenarioNight,
  },
} as const satisfies Record<string, Piece>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;

/**
 * One engraved piece, decorative: an element masked by the scheme's file
 * and filled with the palette's roles (styles.css `illustration`), so it
 * takes every palette in both schemes. Its width comes from the caller
 * (EmptyState's role sizes, or the creator's art place); its height follows
 * the piece's shape. It arrives as surfaces do.
 */
export function Illustration({ name, className }: { name: IllustrationName; className?: string }) {
  const { ratio, lamp, day, night }: Piece = ILLUSTRATIONS[name];
  const style = {
    "--art-day": `url("${day}")`,
    "--art-night": `url("${night}")`,
    "--art-ratio": ratio,
    ...(lamp && { "--art-lamp": `${lamp[0] * 100}% ${lamp[1] * 100}%` }),
  } as CSSProperties;
  return (
    <span
      aria-hidden="true"
      data-illustration={name}
      className={cn("illustration block surface-in", className)}
      style={style}
    />
  );
}
