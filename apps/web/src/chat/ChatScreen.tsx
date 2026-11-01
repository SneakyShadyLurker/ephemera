import {
  Component,
  type ComponentProps,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useFormFactor } from "@/app/form-factor.ts";
import { SCROLL_GUTTERS, ScreenHeader } from "@/app/Screen.tsx";
import { useScheme } from "@/app/theme.tsx";
import { UpdateDock } from "@/app/UpdateFloat.tsx";
import {
  markInspectorUnavailable,
  overlayIntent,
  overlayOwnsKeys,
  toggleSession,
  useUi,
} from "@/app/ui.ts";
import { ClearIcon, InspectIcon, MemoryIcon, MoreIcon, SessionIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { countOf } from "@/lib/text";
import { OpenEpisodeContext, useEpisodeEditor } from "../memory/EpisodeEditor.tsx";
import { applyAtmosphere, useAtmosphere } from "../portraits/atmosphere.ts";
import { useSetting } from "../settings/settings.ts";
import { SignInDock } from "../signin/SignInSlots.tsx";
import { CastHeaderControl, CastSurface } from "./Cast.tsx";
import { ClearChat, useClearChatDialog } from "./ClearChat.tsx";
import { Composer } from "./Composer.tsx";
import { useChatCharacter } from "./character.ts";
import { SCRIPT_FRAME } from "./frame.ts";
import { useGreetings } from "./greetings.ts";
import { MemoryLink, MemoryMark, RememberedCount, useMemoryStatus } from "./MemoryMark.tsx";
import { METER_ID, MeterFigures, PromptButton, useMeterFigures, Waterline } from "./Meter.tsx";
import { ModelNotice } from "./ModelNotice.tsx";
import { loadInspector, openInspector } from "./open-inspector.ts";
import { HeaderPortrait } from "./Presence.tsx";
import { SESSION_SHEET, SessionPanel } from "./SessionPanel.tsx";
import { chatStore, useChat } from "./session.ts";
import { useChatShortcuts } from "./shortcuts.ts";
import { hasChatContent } from "./store.ts";
import { RetentionNote, Thread } from "./Thread.tsx";

// The inspector's code arrives with the page's preload (app/preload.ts).
const Inspector = lazy(() => loadInspector().then((module) => ({ default: module.Inspector })));

/**
 * If the inspector's code did not arrive, opening it closes it again instead
 * of taking the chat screen down; the browser keeps a failed module fetch
 * until the page reloads, so there is nothing to retry.
 */
class InspectorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    markInspectorUnavailable();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ChatScreen() {
  // Leaving the chat cancels an inspector still loading.
  useEffect(() => () => void overlayIntent.next(), []);
  useSessionShortcut();
  useChatShortcuts();
  useGreetings();
  usePreviewOnArrival();
  useRoomTint();
  const composer = useRef<HTMLTextAreaElement>(null);
  const sessionToggle = useRef<HTMLButtonElement>(null);
  // While a reply is in flight; the composer's listening ring reads it (styles.css `lamplight-rim`).
  const writing = useChat((state) => state.generating);
  // One memory editor for the chat, so the seam moving under it keeps it open; a Clear closes it.
  const characterId = useSetting((settings) => settings.characterId);
  const epoch = useChat((state) => state.epoch);
  const [episodeEditor, openEpisode] = useEpisodeEditor(characterId, epoch);
  return (
    <>
      <main
        data-writing={writing ? "" : undefined}
        className="@container/chat flex min-w-0 flex-1 flex-col [timeline-scope:--thread,--presence]"
      >
        <ChatHeader composer={composer} sessionToggle={sessionToggle} />
        <OpenEpisodeContext value={openEpisode}>
          <Thread composer={composer} />
        </OpenEpisodeContext>
        {/* From tablet up, the thread scroller's gutters on both sides, so the composer shares the story's width. */}
        <div className={cn("shrink-0 overflow-hidden pt-1", SCROLL_GUTTERS)}>
          <ModelNotice composer={composer} />
          <SignInDock composer={composer} />
          <div className={SCRIPT_FRAME}>
            <UpdateDock />
          </div>
          <RetentionNote />
          <Composer field={composer} />
        </div>
      </main>
      <SessionPanel toggle={sessionToggle} />
      <InspectorMount />
      <CastSurface />
      {episodeEditor}
    </>
  );
}

function ChatHeader({
  composer,
  sessionToggle,
}: {
  composer: RefObject<HTMLTextAreaElement | null>;
  sessionToggle: RefObject<HTMLButtonElement | null>;
}) {
  const blank = useChat((state) => !hasChatContent(state));
  // With a character chosen there is always something to clear: Clear also closes it.
  const chosen = useSetting((settings) => settings.characterId) !== null;
  const empty = blank && !chosen;
  const sessionOpen = useUi((state) => state.sessionOpen);
  const character = useChatCharacter();
  const phone = useFormFactor() === "phone";
  return (
    <ScreenHeader
      title={character?.name ?? "Chat"}
      edge={<Waterline />}
      // In the script frame from tablet up: the title over the story's start, the actions ending with it.
      frame={SCRIPT_FRAME}
      gutters={SCROLL_GUTTERS}
      lead={phone && character?.portrait != null ? <HeaderPortrait /> : undefined}
      // A character's name in the story face, as its nameplates have it.
      storyTitle={character !== undefined}
      // A character's nameplate stuck under the header names them already (Thread's useNameStuck).
      yieldsTitle={character !== undefined}
    >
      <div className="flex min-w-0 items-center justify-end gap-1">
        {phone ? (
          <>
            {/* The roster scrolls away with the band; this keeps the cast in reach. */}
            <CastHeaderControl />
            <ChatMenu composer={composer} empty={empty} />
          </>
        ) : (
          <>
            <MeterFigures />
            <MemoryMark />
            <ClearChat composer={composer} trigger={<ClearTrigger disabled={empty} />} />
            <PromptButton />
          </>
        )}
        <Tooltip label="Session" shortcut="Ctrl ." side="bottom">
          <Button
            ref={sessionToggle}
            size="icon"
            aria-label="Session"
            aria-pressed={sessionOpen}
            onClick={toggleSession}
          >
            <SessionIcon />
          </Button>
        </Tooltip>
      </div>
    </ScreenHeader>
  );
}

/** Clear's icon button; the dialog trigger's props and ref reach the button under its tooltip. */
function ClearTrigger(props: ComponentProps<typeof Button>) {
  return (
    <Tooltip label="Clear chat" side="bottom">
      <Button size="icon" aria-label="Clear chat" {...props}>
        <ClearIcon />
      </Button>
    </Tooltip>
  );
}

/**
 * Phones: the header keeps the name, the cast and Session, and this menu
 * holds the rest under the labels the wider header gives them: Memory with
 * how many turns it remembers, Prompt with the meter's figures once the
 * window is nearly full, and Clear chat. The remembered count also sits in
 * the menu button's corner, as on the Memory mark, so it shows without
 * opening the menu.
 */
function ChatMenu({
  composer,
  empty,
}: {
  composer: RefObject<HTMLTextAreaElement | null>;
  empty: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const memory = useMemoryStatus();
  const figures = useMeterFigures();
  const clear = useClearChatDialog({ composer, returnTo: trigger });
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button ref={trigger} size="icon" aria-label="More chat actions" />}>
          <MoreIcon />
          {memory !== null && <RememberedCount count={memory.remembered} />}
        </MenuTrigger>
        <MenuContent label="Chat actions">
          {memory !== null && (
            <MenuLinkItem closeOnClick render={<MemoryLink characterId={memory.characterId} />}>
              <MemoryIcon size={16} />
              <span className="flex-1">Memory</span>
              {memory.remembered > 0 && (
                <span className="text-meta text-reed tabular-nums">
                  {countOf(memory.remembered, "turn")} remembered
                </span>
              )}
            </MenuLinkItem>
          )}
          <MenuItem
            aria-describedby={figures === null ? undefined : METER_ID}
            onClick={() => void openInspector()}
          >
            <InspectIcon size={16} />
            <span className="flex-1">Prompt</span>
            {figures !== null && (
              <span aria-hidden="true" className="text-meta text-reed tabular-nums">
                {figures}
              </span>
            )}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger disabled={empty} onClick={clear.request}>
            <ClearIcon size={16} />
            Clear chat
          </MenuItem>
        </MenuContent>
      </Menu>
      {clear.dialog}
    </>
  );
}

/**
 * Returning to the chat rebuilds the next prompt's preview, so a card or
 * preset edited on another screen shows; settings changes are followed
 * wherever they happen (session.ts).
 */
function usePreviewOnArrival() {
  useEffect(() => {
    chatStore.getState().schedulePreview();
  }, []);
}

/**
 * The room leans toward the character portrait's hue while the chat shows;
 * leaving the chat fades it out. The tint lives in this screen's memory only.
 */
function useRoomTint() {
  const tint = useAtmosphere(useChatCharacter(), useScheme());
  useEffect(() => applyAtmosphere(tint), [tint]);
  useEffect(() => () => applyAtmosphere(null), []);
}

/** Mounts the inspector the first time it is opened, then keeps it for its exit motion. */
function InspectorMount() {
  const open = useUi((state) => state.inspectorOpen);
  const [opened, setOpened] = useState(false);
  if (open && !opened) setOpened(true);
  if (!open && !opened) return null;
  return (
    <InspectorBoundary>
      <Suspense fallback={null}>
        <Inspector />
      </Suspense>
    </InspectorBoundary>
  );
}

/**
 * Ctrl+. (or Cmd+.) opens and closes Session from anywhere in the chat,
 * Session's own sheet included, except while another overlay owns the keys.
 */
function useSessionShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "." &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !overlayOwnsKeys(event, SESSION_SHEET)
      ) {
        event.preventDefault();
        toggleSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
