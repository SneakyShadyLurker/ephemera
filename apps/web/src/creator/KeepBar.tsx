import type { CreatorKind } from "@ephemera/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { forgetScroll } from "@/app/KeptScroll.tsx";
import { SCROLL_GUTTERS } from "@/app/Screen.tsx";
import { ChevronDownIcon, DeleteIcon, EditIcon, RegenerateIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { setOpened } from "../characters/gallery-state.ts";
import { charactersQuery, refreshCharacters } from "../characters/queries.ts";
import { portraitUrl } from "../portraits/queries.ts";
import { notReached } from "../signin/signin.ts";
import { CREATOR_FRAME } from "./CardLayout.tsx";
import { keepAndLeave } from "./keep.ts";
import { keptStore } from "./kept.ts";
import { creatorStore, useCreator } from "./session.ts";
import type { KeepFailure } from "./store.ts";
import { inTransition } from "./transition.ts";

/** What a failed Keep says, in the interface's voice. */
function failureText(failure: KeepFailure, name: string): string {
  if (failure.step === "portrait") return `Kept ${name} without its portrait. ${failure.reason}`;
  switch (failure.reason) {
    case "invalid":
      return "Not kept: the card was refused as invalid.";
    case "too_large":
      return "Not kept: the card is over the size limit.";
    default:
      return `Not kept: ${notReached()}.`;
  }
}

/** The longest Keep waits on the portrait: past it the gallery shows the tile, drawn or not. */
const PRELOAD_CAP_MS = 600;

/** A kept portrait loads before the gallery shows it, briefly, so the art travels into a drawn tile. */
async function preloadPortrait(id: string, version: number | null): Promise<void> {
  if (version === null) return;
  const image = new Image();
  image.src = portraitUrl("characters", id, version, "thumb");
  await Promise.race([
    image.decode().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, PRELOAD_CAP_MS)),
  ]);
}

/**
 * The showcase's action bar, pinned under the scroller: one primary, Keep,
 * and More with Keep and edit and, apart, Rewrite and Discard, each behind a
 * confirmation. Until a batch of portraits is on show, Keep says it keeps
 * the card without one. While Keep saves it reads "Keeping…" and nothing
 * else runs.
 * Kept, the creator's session is emptied and the art travels into the
 * gallery (or the sheet) by the route's view transition.
 */
export function KeepBar({ kind }: { kind: CreatorKind }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const keepRun = useCreator((s) => s.keepRun);
  const rewrite = useCreator((s) => s.rewrite);
  const discard = useCreator((s) => s.discard);
  const portraitless = useCreator((s) => s.images.length === 0);
  // Which confirmation, kept apart from whether it is open so its words hold while it closes.
  const [confirm, setConfirm] = useState<"rewrite" | "discard">("discard");
  const [asking, setAsking] = useState(false);
  const ask = (which: "rewrite" | "discard") => {
    setConfirm(which);
    setAsking(true);
  };
  const more = useRef<HTMLButtonElement>(null);
  const saving = keepRun?.status === "saving" || keepRun?.status === "kept";
  const failure = keepRun?.status === "failed" ? keepRun.failure : null;
  const noun = kind === "scenario" ? "scenario" : "character";

  const keep = (then: "gallery" | "sheet") =>
    keepAndLeave(
      creatorStore,
      {
        settle: async (run) => {
          await refreshCharacters(queryClient, run.snapshot.id);
          if (then === "gallery") {
            await Promise.all([
              queryClient.fetchQuery(charactersQuery).catch(() => undefined),
              preloadPortrait(run.snapshot.id, run.portrait),
            ]);
          }
        },
        leave: async ({ snapshot: { id, name } }) => {
          setOpened(id);
          if (then === "gallery") {
            keptStore.setState({ kept: { id, name } });
            forgetScroll("characters");
            await navigate({ to: "/characters" });
          } else {
            await navigate({ to: "/characters/$id", params: { id } });
          }
        },
      },
      // After a portrait failure the card is kept: editing it needs no second try.
      then === "sheet" && creatorStore.getState().keepRun?.saved === true,
    );

  const primary =
    keepRun?.status === "saving" || keepRun?.status === "kept"
      ? "Keeping…"
      : failure?.step === "portrait"
        ? "Try the portrait again"
        : failure !== null
          ? "Try again"
          : portraitless
            ? "Keep without portrait"
            : `Keep ${noun}`;

  return (
    // The scroller's gutters above it, so the bar's frame keeps the content's edges.
    <div
      className={cn(
        "shrink-0 overflow-hidden border-rush border-t bg-canvas pb-[env(safe-area-inset-bottom)]",
        SCROLL_GUTTERS,
      )}
    >
      <div
        className={cn(
          CREATOR_FRAME,
          "flex flex-wrap items-center justify-end gap-x-2 gap-y-2 py-3",
        )}
      >
        {failure !== null && keepRun !== null && (
          <p role="alert" className="mr-auto min-w-0 text-pretty text-ember text-note">
            {failureText(failure, keepRun.snapshot.name)}
          </p>
        )}
        <p role="status" className="sr-only">
          {keepRun?.status === "saving" ? "Keeping." : ""}
        </p>
        <Menu>
          <MenuTrigger
            render={
              <Button
                ref={more}
                variant="quiet"
                disabled={saving}
                className="max-tablet:h-11 max-tablet:px-4"
              />
            }
          >
            More
            <ChevronDownIcon size={16} />
          </MenuTrigger>
          <MenuContent label={`More for this ${noun}`}>
            <MenuItem onClick={() => void keep("sheet")}>
              <EditIcon size={16} />
              Keep and edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => ask("rewrite")}>
              <RegenerateIcon size={16} />
              Rewrite
            </MenuItem>
            <MenuItem danger onClick={() => ask("discard")}>
              <DeleteIcon size={16} />
              Discard
            </MenuItem>
          </MenuContent>
        </Menu>
        <Button
          variant="primary"
          aria-disabled={saving || undefined}
          className={cn("max-tablet:h-11 max-tablet:px-4", saving && "pointer-events-none")}
          onClick={() => {
            if (!saving) void keep("gallery");
          }}
        >
          {primary}
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={confirm === "rewrite" ? `Rewrite this ${noun}?` : `Discard this ${noun}?`}
        description={
          confirm === "rewrite"
            ? "The current card and its portraits are lost, and the model writes another from your description."
            : "The card and its portraits are lost. Your description is kept."
        }
        finalFocus={more}
        confirm={confirm === "rewrite" ? "Rewrite" : "Discard"}
        onConfirm={() => inTransition(confirm === "rewrite" ? rewrite : discard)}
      />
    </div>
  );
}
