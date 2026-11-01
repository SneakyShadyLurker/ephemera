import { imagePromptModelOf } from "@ephemera/core";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useShallow } from "zustand/shallow";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { SceneIcon, StopIcon } from "@/components/icons";
import { LamplightRim } from "@/components/lamplight.tsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { COMFYUI_BUSY, MODEL_BUSY } from "@/lib/text";
import { ArtCanvas } from "../creator/ArtCanvas.tsx";
import { decodePng } from "../creator/art.ts";
import type { ArtImage } from "../creator/art-slice.ts";
import { artProgress } from "../creator/progress.ts";
import { useSetting } from "../settings/settings.ts";
import { useChatCharacter } from "./character.ts";
import { onItsWay, type SceneRun } from "./scene-slice.ts";
import { chatStore, useChat } from "./session.ts";

/*
 * Picture this scene in the thread (PRINCIPLES.md 1). The picture is a print
 * laid into the story: a 2:3 plate reserved from the press, so nothing moves
 * when it lands, with one hairline frame and one line under it. While it is
 * painted the lamp's light travels its rim (closing when it is done) and a
 * thin dusk line measures the steps; the picture develops out of blur once,
 * and a quick fade brings it back after it was scrolled away. Its bytes are
 * drawn from memory onto a canvas, never given a URL, and decoded only while
 * the plate is within a viewport of view, so many pictures never hold many
 * bitmaps.
 */

/** The item's stage line, which the button names as its description while it runs. */
const stageId = (id: string) => `scene-stage-${id}`;

/** A picture shown before comes back with a quick fade, not the develop. */
const QUICK_FADE = "transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

/** The small controls under a plate: quiet, at the caption's size. */
const CONTROL = "h-8 px-2 text-note touch:h-11";

/** The press whose new plate brings itself into view once, if it is out of view. */
let revealing: string | null = null;

/** Pictures that developed once; they come back with a quick fade. Held by their bytes, so they go with them. */
const developed = new WeakSet<ArtImage>();

/** Why a picture failed, in a sentence. */
function failure(run: Extract<SceneRun, { status: "failed" }>): string {
  switch (run.code) {
    case "upstream":
      return "The model could not write the image prompt.";
    case "upstream_busy":
      return MODEL_BUSY;
    case "timeout":
      return "The picture ran past its deadline.";
    case "not_configured":
      return "No ComfyUI address is saved.";
    case "not_allowed":
      return "This server does not allow the saved ComfyUI address.";
    case "comfyui":
      return "ComfyUI failed or returned an unusable picture.";
    case "comfyui_busy":
      return COMFYUI_BUSY;
    case "stream":
      return "The connection broke off before the picture arrived.";
    case "not_found":
      return "This character was deleted.";
    case "reference":
      return "The stored portrait could not be prepared for the model.";
    case "empty":
      return "The chat has nothing to picture yet.";
    case "no_model":
      return "Choose a model to write the image prompt.";
  }
}

/** Why ComfyUI was not asked, in a sentence. */
function skipped(run: Extract<SceneRun, { status: "skipped" }>): string {
  switch (run.reason) {
    case "missing":
      return "It is missing nodes or models the chosen workflow needs; Settings lists them.";
    case "unavailable":
      return "It could not be reached or is not ready.";
    case "off":
      return "No ComfyUI address is saved.";
    default:
      return "Its status could not be checked.";
  }
}

/**
 * Under the portrait, in the float and in the phone band: one picture of the
 * moment per press. Hidden while no ComfyUI address is saved; held while a
 * reply or a picture is on its way and before the chat shows a turn. A
 * column under 10rem shows "Picture" beside the icon; the name is always
 * the whole action.
 */
export function SceneButton({ wide }: { wide: boolean }) {
  const address = useSetting((settings) => settings.comfyuiBaseUrl);
  // The model the picture's image prompt goes to, as pictureScene resolves it.
  const model = useSetting((settings) =>
    imagePromptModelOf(null, settings.imagePromptModel, settings.model),
  );
  const running = useChat((state) => state.scenes.find((item) => onItsWay(item.run))?.id);
  const ready = useChat(
    (state) => !state.generating && state.messages.length > state.memory.horizon,
  );
  if (address === "") return null;
  const press = () => {
    const before = chatStore.getState().scenes.at(-1);
    chatStore.getState().pictureScene();
    const added = chatStore.getState().scenes.at(-1);
    if (added !== undefined && added !== before) revealing = added.id;
  };
  return (
    <Button
      variant="quiet"
      aria-label="Picture this scene"
      aria-describedby={running === undefined ? undefined : stageId(running)}
      disabled={!ready || model === null || running !== undefined}
      focusableWhenDisabled
      onClick={press}
      className="w-full justify-start gap-1.5 px-1.5 text-note"
    >
      <SceneIcon size={16} />
      <span>
        Picture
        {wide && <span className="max-desktop:hidden"> this scene</span>}
      </span>
    </Button>
  );
}

/** The pictures that follow the message `anchorId`, in the order they were asked for. */
export function SceneItems({ anchorId, enter }: { anchorId: string; enter: boolean }) {
  const ids = useChat(
    useShallow((state) =>
      state.scenes.filter((item) => item.anchorId === anchorId).map((item) => item.id),
    ),
  );
  return ids.map((id) => <SceneItem key={id} id={id} enter={enter} />);
}

function SceneItem({ id, enter }: { id: string; enter: boolean }) {
  const item = useChat((state) => state.scenes.find((scene) => scene.id === id));
  const character = useChatCharacter();
  const plate = useRef<HTMLDivElement>(null);
  const near = useNearView(plate);
  const decoded = useSceneBitmap(item?.png, near);
  useRevealOnce(id, plate);
  if (item === undefined) return null;
  const { getState } = chatStore;
  return (
    <SceneView
      id={id}
      run={item.run}
      name={item.request.written?.name ?? character?.name ?? ""}
      decoded={decoded}
      enter={enter}
      plateRef={plate}
      onStop={() => getState().stopScene()}
      onRetry={() => getState().retryScene(id)}
      onHide={() => getState().hideScene(id)}
    />
  );
}

/** A picture as the plate can draw it: not yet in hand, drawn, or unreadable. */
export type SceneBitmap =
  | { status: "none" }
  | { status: "ready"; bitmap: ImageBitmap; fresh: boolean }
  | { status: "failed" };

/**
 * One scene picture: the plate, its stage or caption, and its controls. The
 * stage and a failure are said politely from a live region in place before
 * the words arrive; the step count is there to read, never announced.
 */
export function SceneView({
  id,
  run,
  name,
  decoded,
  enter = true,
  plateRef,
  onStop,
  onRetry,
  onHide,
}: {
  id: string;
  run: SceneRun;
  name: string;
  decoded: SceneBitmap;
  enter?: boolean;
  plateRef?: RefObject<HTMLDivElement | null>;
  onStop: () => void;
  onRetry: () => void;
  onHide: () => void;
}) {
  const painting = run.status === "running";
  const progress = artProgress(run, "picture");
  const label = `Scene with ${name}`;
  const retry = useRef<HTMLButtonElement>(null);
  const stopping = useRef(false);
  // Stop leaves with focus: it moves to Paint it again, which takes its place.
  useEffect(() => {
    if (!stopping.current || run.status === "running" || run.status === "waiting") return;
    stopping.current = false;
    retry.current?.focus();
  }, [run.status]);

  let line: ReactNode;
  let live = "";
  let controls: "stop" | "retry" | "hide" | null = null;
  if (run.status === "running") {
    live = progress?.label ?? "";
    line = (
      <span className="grid gap-0.5">
        <span id={stageId(id)} aria-hidden="true" className="text-ink">
          <span
            key={live}
            className="transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
          >
            {live}
          </span>
        </span>
        {/* Eases in with each stage; a count or a place in line then changes in place. */}
        {progress?.detail !== undefined && (
          <span
            key={live}
            className="text-reed tabular-nums transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0"
          >
            {progress.detail}
          </span>
        )}
      </span>
    );
    controls = "stop";
  } else if (run.status === "waiting") {
    live = "Waiting for sign-in";
    line = (
      <span id={stageId(id)} aria-hidden="true" className="text-ink">
        {live}
      </span>
    );
    controls = "stop";
  } else if (run.status === "skipped") {
    live = `ComfyUI is not ready. ${skipped(run)}`;
    line = (
      <span aria-hidden="true" className="grid gap-0.5">
        <span className="text-ink">ComfyUI is not ready</span>
        <span className="text-pretty text-reed">{skipped(run)}</span>
      </span>
    );
    controls = "retry";
  } else if (run.status === "stopped") {
    line = <span className="text-reed">Stopped</span>;
    controls = "retry";
  } else if (run.status === "failed") {
    live = `The picture failed. ${failure(run)}`;
    line = (
      <span aria-hidden="true" className="text-pretty text-ink">
        The picture <span className="text-ember">failed</span>. {failure(run)}
      </span>
    );
    controls = "retry";
  } else if (decoded.status === "failed") {
    live = "The picture could not be shown";
    line = (
      <span aria-hidden="true" className="text-ink">
        {live}
      </span>
    );
    controls = "hide";
  } else {
    // The canvas carries the name; the caption is there to read.
    line = (
      <span aria-hidden={decoded.status === "ready" ? true : undefined} className="text-reed">
        {label}
      </span>
    );
  }

  const bitmap = run.status === "complete" && decoded.status === "ready" ? decoded : undefined;
  const meter = painting ? progress?.line : undefined;
  return (
    <li
      data-scene=""
      data-status={run.status}
      className={cn("grid justify-items-start gap-2.5", enter && "surface-in")}
    >
      <div ref={plateRef} className="relative isolate w-full tablet:w-[min(100%,32rem)]">
        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-(--radius) bg-surface">
          {bitmap !== undefined && (
            <ArtCanvas
              bitmap={bitmap.bitmap}
              label={label}
              className={cn("absolute inset-0", bitmap.fresh ? "develop-in" : QUICK_FADE)}
            />
          )}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[inherit] border border-control-edge/35"
          />
          {typeof meter === "number" && (
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-px origin-left bg-dusk transition-[scale] duration-(--duration-panel-in) ease-fade"
              style={{ scale: `${Math.min(1, Math.max(0, meter))} 1` }}
            />
          )}
        </div>
        <LamplightRim busy={painting} settled={run.status === "complete"} />
      </div>
      {/* As tall as its controls, so the caption replacing them moves nothing. */}
      <div className="flex min-h-8 w-full items-start justify-between gap-4 touch:min-h-11 tablet:w-[min(100%,32rem)]">
        <p
          className={cn(
            "min-w-0 pt-1.5",
            run.status === "complete" && decoded.status !== "failed" ? "text-meta" : "text-note",
          )}
        >
          {/* In place before its words arrive, so the first stage is said. */}
          <span role="status" className="sr-only">
            {live}
          </span>
          {line}
        </p>
        {controls !== null && (
          <div className="-mr-2 flex shrink-0 items-center gap-1">
            {controls === "stop" && (
              <Button
                variant="quiet"
                aria-label="Stop the picture"
                className={CONTROL}
                onClick={() => {
                  stopping.current = true;
                  onStop();
                }}
              >
                <StopIcon size={16} />
                Stop
              </Button>
            )}
            {controls === "retry" && (
              <Button ref={retry} variant="quiet" className={CONTROL} onClick={onRetry}>
                Paint it again
              </Button>
            )}
            {controls !== "stop" && (
              <Button
                variant="quiet"
                aria-label="Hide this picture"
                className={CONTROL}
                onClick={onHide}
              >
                Hide
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Whether the plate is within one viewport of the story's view, measured by its scroller. */
function useNearView(ref: RefObject<HTMLElement | null>): boolean {
  const { scrollRef } = useStickToBottomContext();
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) setNear(entry.isIntersecting);
      },
      { root: scrollRef.current, rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, scrollRef]);
  return near;
}

/**
 * The picture's bitmap while the plate is `near` view: decoded from its bytes
 * and closed when it leaves, on unmount and when the chat's epoch changes; a
 * decode that resolves after any of those is closed at once and never shown.
 */
function useSceneBitmap(png: ArtImage | undefined, near: boolean): SceneBitmap {
  const epoch = useChat((state) => state.epoch);
  const [decoded, setDecoded] = useState<{ png: ArtImage; result: SceneBitmap } | null>(null);
  useEffect(() => {
    if (png === undefined || !near) return;
    let live = true;
    let bitmap: ImageBitmap | undefined;
    const fresh = !developed.has(png);
    decodePng(png).then(
      (decodedBitmap) => {
        if (!live || chatStore.getState().epoch !== epoch) {
          decodedBitmap.close();
          return;
        }
        bitmap = decodedBitmap;
        developed.add(png);
        setDecoded({ png, result: { status: "ready", bitmap: decodedBitmap, fresh } });
      },
      () => {
        if (live) setDecoded({ png, result: { status: "failed" } });
      },
    );
    return () => {
      live = false;
      if (bitmap === undefined) return;
      // The canvas left with the render that ended this decode; its bitmap goes after it.
      bitmap.close();
      setDecoded(null);
    };
  }, [png, near, epoch]);
  if (png === undefined || decoded?.png !== png) return { status: "none" };
  if (decoded.result.status === "ready" && !near) return { status: "none" };
  return decoded.result;
}

/**
 * The item a press added comes into view once, its stage line and Stop
 * included, unless it is already in full view; progress never scrolls.
 */
function useRevealOnce(id: string, ref: RefObject<HTMLElement | null>) {
  const { scrollRef } = useStickToBottomContext();
  useEffect(() => {
    if (revealing !== id) return;
    revealing = null;
    const element = ref.current?.closest("li") ?? ref.current;
    const scroller = scrollRef.current;
    if (element == null || scroller === null) return;
    const rect = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
    element.scrollIntoView({ block: "end", behavior: scrollBehavior() });
  }, [id, ref, scrollRef]);
}
