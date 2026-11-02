import {
  customPaletteCss,
  customPaletteId,
  type PaletteChoice,
  paletteAttribute,
  type Theme,
} from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import {
  addTransitionType,
  createContext,
  type ReactNode,
  startTransition,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { draftPalette, usePaletteDraft } from "../palettes/draft.ts";
import { customPalettesQuery } from "../palettes/queries.ts";
import { settingsQuery, useSettings, useUpdateSettings } from "../settings/settings.ts";

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Applies the choice and the palette to <html>, then matches Android Chrome's
 * address bar to the canvas: the palette's own, never the portrait's tint
 * (styles.css `data-atmosphere`).
 */
function applyTheme(choice: Theme, palette: PaletteChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  const attribute = paletteAttribute(palette);
  if (attribute === undefined) delete root.dataset.palette;
  else root.dataset.palette = attribute;
  const probe = document.createElement("span");
  probe.style.color = "var(--canvas-base)";
  root.append(probe);
  const canvas = getComputedStyle(probe).color;
  probe.remove();
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = canvas;
  }
}

let customSheet: CSSStyleSheet | undefined;

/**
 * The player's palettes, painted through one constructed stylesheet (the
 * policy governs no CSSOM), after the server's linked one, which it
 * replaces once the list has loaded.
 */
function paintCustomPalettes(css: string): void {
  if (customSheet === undefined) {
    customSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, customSheet];
  }
  customSheet.replaceSync(css);
}

const ThemeContext = createContext<{
  choice: Theme;
  setChoice: (choice: Theme) => void;
  palette: PaletteChoice;
  /** Chooses and saves a palette; crossfades unless it already shows (a palette just edited). */
  setPalette: (palette: PaletteChoice, crossfade?: boolean) => void;
  /** Shows a palette the server already chose (after a deletion), without saving it again. */
  followPalette: (palette: PaletteChoice) => void;
  /** The theme the window shows: the choice, or the scheme the palette editor is editing. */
  shown: Theme;
} | null>(null);

/**
 * The applied theme and palette are presentation state owned here, started
 * from the saved settings (which the server also paints onto the app shell,
 * so a reload does not flash). A change runs as a Transition typed "theme",
 * so React's View Transition crossfades the page, and is saved as a UI setting.
 * While the palette editor is open, its draft is what the app shows, in the
 * scheme being edited; closing it puts the saved palette and theme back.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const saved = useSettings();
  const loaded = useQuery(settingsQuery).data !== undefined;
  const updateSettings = useUpdateSettings();
  const [choice, setChoiceState] = useState<Theme>(saved.theme);
  const [palette, setPaletteState] = useState<PaletteChoice>(saved.palette);
  // Own state, not the saved settings themselves, so each change can run as a
  // typed Transition. A tab that started on the fallback settings takes the
  // saved ones once, when they first arrive (this tab's changes already laid
  // over them); later saves never write back into it.
  const [adopted, setAdopted] = useState(loaded);
  if (loaded && !adopted) {
    setAdopted(true);
    setChoiceState(saved.theme);
    setPaletteState(saved.palette);
  }
  const customs = useQuery(customPalettesQuery).data;
  const draft = usePaletteDraft();
  const shown = draft?.scheme ?? choice;
  const shownPalette = draft === null ? palette : customPaletteId(draft.slot);

  // Inside React's view transition update, so the new theme is what gets captured.
  useLayoutEffect(() => {
    // Before the list loads the server's stylesheet paints the saved ones; a draft paints at once.
    if (customs !== undefined || draft !== null) {
      const others = (customs ?? []).filter((custom) => custom.slot !== draft?.slot);
      paintCustomPalettes(
        customPaletteCss(draft === null ? others : [...others, draftPalette(draft)]),
      );
    }
    applyTheme(shown, shownPalette);
  }, [customs, draft, shown, shownPalette]);

  useEffect(() => {
    const follow = () => applyTheme(shown, shownPalette);
    systemDark.addEventListener("change", follow);
    return () => systemDark.removeEventListener("change", follow);
  }, [shown, shownPalette]);

  const setChoice = (next: Theme) => {
    startTransition(() => {
      addTransitionType("theme");
      setChoiceState(next);
    });
    updateSettings({ theme: next });
  };

  const setPalette = (next: PaletteChoice, crossfade = true) => {
    if (crossfade) {
      startTransition(() => {
        addTransitionType("theme");
        setPaletteState(next);
      });
    } else {
      setPaletteState(next);
    }
    updateSettings({ palette: next });
  };

  // In the same commit as the editor closing, so the deleted palette's
  // draft never shows the old palette in between.
  const followPalette = (next: PaletteChoice) => setPaletteState(next);

  return (
    <ThemeContext value={{ choice, setChoice, palette, setPalette, followPalette, shown }}>
      {children}
    </ThemeContext>
  );
}

const followSystem = (onChange: () => void) => {
  systemDark.addEventListener("change", onChange);
  return () => systemDark.removeEventListener("change", onChange);
};

/** The scheme the window shows: the shown theme, or the system's under "system". */
export function useScheme(): "light" | "dark" {
  const { shown } = useTheme();
  const dark = useSyncExternalStore(followSystem, () => systemDark.matches);
  return shown === "system" ? (dark ? "dark" : "light") : shown;
}

export function useTheme() {
  const theme = use(ThemeContext);
  if (theme === null) throw new Error("useTheme needs a ThemeProvider");
  return theme;
}
