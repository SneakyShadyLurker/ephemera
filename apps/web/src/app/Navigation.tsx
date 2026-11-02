import { Link, useMatchRoute } from "@tanstack/react-router";
import { GLIDE } from "@/app/glide.ts";
import {
  CharactersIcon,
  ChatIcon,
  LorebookIcon,
  MarkIcon,
  PersonaIcon,
  PresetsIcon,
  SettingsIcon,
} from "@/components/icons";
import {
  Drawer,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/cn";
import { useInFlight } from "./Screen.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { setNavOpen, useUi } from "./ui.ts";

const DESTINATIONS = [
  { to: "/", label: "Chat", Icon: ChatIcon },
  { to: "/characters", label: "Characters", Icon: CharactersIcon },
  { to: "/personas", label: "Personas", Icon: PersonaIcon },
  { to: "/lorebooks", label: "Lorebooks", Icon: LorebookIcon },
  { to: "/presets", label: "Presets", Icon: PresetsIcon },
  { to: "/settings", label: "Settings", Icon: SettingsIcon },
] as const;

/**
 * The active row's marker, in the palette's accent line: it says "you are
 * here", over a ground only a step off the rail's. One exists at a time, so
 * its transition name makes it glide between rows.
 */
function Marker() {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-full bg-dusk-line [view-transition-name:nav-marker]",
        GLIDE,
      )}
    />
  );
}

function Destinations({
  layout,
  onNavigate,
}: {
  layout: "rail" | "icons" | "sheet";
  onNavigate?: () => void;
}) {
  // The memory screen the chat's Memory mark opened is the chat's: Chat is marked, not Characters.
  const fromChat =
    useMatchRoute()({ to: "/characters/$id/memory", search: { from: "chat" } }) !== false;
  return (
    <ul className={cn("grid", layout === "icons" ? "gap-1" : "gap-0.5")}>
      {DESTINATIONS.map(({ to, label, Icon }) => (
        <li key={to}>
          <Link
            to={to}
            // Characters matches its own screen exactly then, so the memory screen is not its.
            activeOptions={{ exact: fromChat && to === "/characters" }}
            {...(fromChat && to === "/"
              ? ({ "data-status": "active", "aria-current": "page" } as const)
              : {})}
            onClick={onNavigate}
            className={cn(
              "press group relative flex items-center rounded-md font-medium text-reed hover:bg-surface-hover hover:text-ink data-[status=active]:bg-surface data-[status=active]:text-ink data-[status=active]:hover:bg-surface-hover",
              layout === "rail" && "h-11 gap-3 px-3 text-ui",
              layout === "sheet" && "h-13 gap-4 px-4 text-lead",
              layout === "icons" && "h-14 flex-col justify-center gap-1 text-tag leading-none",
            )}
          >
            {({ isActive }) => (
              <>
                {isActive && <Marker />}
                <Icon size={layout === "sheet" ? 24 : 20} />
                {label}
              </>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Desktop: text rail under the stacked lockup, the mark above the wordmark on
 * the destinations' left edge. Tablet: icons over persistent labels.
 */
export function Rail({ compact }: { compact: boolean }) {
  const writing = useInFlight();
  return (
    <nav
      aria-label="Main"
      className={cn(
        "flex h-dvh shrink-0 flex-col overflow-y-auto border-rush border-r pb-4",
        compact ? "w-20 items-stretch px-1.5" : "w-52 px-3",
      )}
    >
      <div
        className={cn(
          "text-ink",
          compact
            ? "flex h-14 shrink-0 items-center justify-center"
            : "grid justify-items-start gap-3 px-3 pt-6",
        )}
      >
        {/* The crescent sits inside its drawing box; the nudge sets its edge on the wordmark's. */}
        <span className={cn("grid", !compact && "-ml-0.5")}>
          <MarkIcon
            dripping
            writing={writing}
            size={compact ? 32 : 44}
            aria-label={compact ? "Ephemera" : undefined}
          />
        </span>
        {!compact && <span className="font-display text-wordmark tracking-[0.04em]">Ephemera</span>}
      </div>
      <div className={compact ? "mt-3" : "mt-6"}>
        <Destinations layout={compact ? "icons" : "rail"} />
      </div>
      <div className={cn("mt-auto", compact ? "flex justify-center" : "px-1")}>
        <ThemeSwitch orientation={compact ? "vertical" : "horizontal"} />
      </div>
    </nav>
  );
}

/**
 * Phone: navigation is a bottom sheet, the same overlay grammar as Session:
 * its header the lockup as title, then the close control.
 */
export function NavSheet() {
  const open = useUi((state) => state.navOpen);
  return (
    <Drawer open={open} onOpenChange={setNavOpen} showSwipeHandle>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2 pl-2 font-normal">
            <MarkIcon size={20} />
            <span className="font-display text-wordmark tracking-[0.04em]">Ephemera</span>
          </DrawerTitle>
          <DrawerCloseIcon label="Close navigation" />
        </DrawerHeader>
        <nav
          aria-label="Main"
          className="min-h-0 overflow-y-auto px-3 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <Destinations layout="sheet" onNavigate={() => setNavOpen(false)} />
        </nav>
      </DrawerContent>
    </Drawer>
  );
}
