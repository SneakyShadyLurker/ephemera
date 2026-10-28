import { THEMES, type Theme } from "@ephemera/core";
import { ViewTransition } from "react";
import { MoonIcon, SunIcon, SystemIcon } from "@/components/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip } from "@/components/ui/tooltip";
import { oneOf } from "@/lib/one-of.ts";
import { useTheme } from "./theme.tsx";

const THEME_TEXT = {
  system: { label: "Match system", Icon: SystemIcon },
  light: { label: "Light", Icon: SunIcon },
  dark: { label: "Dark", Icon: MoonIcon },
} as const satisfies Record<Theme, { label: string; Icon: unknown }>;

/** Core's themes, in its order. */
const OPTIONS = THEMES.map((value) => ({ value, ...THEME_TEXT[value] }));

const isChoice = oneOf(THEMES);

/**
 * System, Light or Dark; named by its group. Icons alone with tooltips in the
 * rail; `labelled` shows each option's name beside its icon (Settings).
 */
export function ThemeSwitch({
  orientation = "horizontal",
  labelled = false,
}: {
  orientation?: "horizontal" | "vertical";
  labelled?: boolean;
}) {
  const { choice, setChoice } = useTheme();
  return (
    // The pressed option changes inside the Transition, which starts React's view transition.
    <ViewTransition>
      <ToggleGroup
        aria-label="Theme"
        orientation={orientation}
        className={orientation === "vertical" ? "flex-col" : "w-fit"}
        value={[choice]}
        onValueChange={(value) => {
          const next = value[0];
          if (isChoice(next)) setChoice(next);
        }}
      >
        {OPTIONS.map(({ value, label, Icon }) =>
          labelled ? (
            <ToggleGroupItem key={value} value={value} labelled>
              <Icon size={16} />
              {label}
            </ToggleGroupItem>
          ) : (
            <Tooltip key={value} label={label} side={orientation === "vertical" ? "right" : "top"}>
              <ToggleGroupItem value={value} aria-label={label}>
                <Icon />
              </ToggleGroupItem>
            </Tooltip>
          ),
        )}
      </ToggleGroup>
    </ViewTransition>
  );
}
