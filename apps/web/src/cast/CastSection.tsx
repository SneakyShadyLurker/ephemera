import {
  type CastSheetResponse,
  castModelOf,
  castReasoningOf,
  type Settings,
} from "@ephemera/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { sharedCallFailure } from "../model-call.ts";
import { currentSettings, useSettings } from "../settings/settings.ts";
import { WindowLink } from "../settings/window-link.tsx";
import { HELP, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
import { ageOf } from "./age.ts";
import { CAST_SHEET_KEY, type CastFailure, castSheetQuery, ensureCastSheet } from "./queries.ts";

/** Why Read now or Regenerate gave no sheet: the call's failure, or no model to ask. */
type CastReadFailure = CastFailure | "no_model";

const NOT_READ = "The cast was not read";

/**
 * A failed read in words and, where it is Settings, the way out; the
 * section's own button reads again.
 */
function castReadFailure(reason: CastReadFailure): {
  text: string;
  action: "window" | "settings" | null;
} {
  const say = (words: string, action: "window" | "settings" | null = null) => ({
    text: `${NOT_READ}: ${words}.`,
    action,
  });
  switch (reason) {
    case "unreachable":
    case "signed_out":
    case "timeout":
    case "upstream_busy":
    case "invalid":
    case "context_window_unknown":
    case "no_model": {
      const { words, action } = sharedCallFailure(reason, "cast");
      return say(words, action === "retry" ? null : action);
    }
    case "cast_failed":
      return say("the cast model's answer failed");
    case "aborted":
      return say("the request was stopped");
    case "prompt_too_long":
      return say("the card is too long for the cast model's context window", "settings");
    case "too_large":
      return say("the card is too large to send");
    case "not_found":
      return say("this character no longer exists");
  }
}

/** What each way out to Settings is called. */
const CAST_ACTION_LABEL = { window: "Set a context window", settings: "Cast settings" } as const;

/**
 * Reads the character's cast sheet from the card now (`force`: even when the
 * stored one is current) and puts it in the sheet's query; the failure when
 * there is none. The server's job outlives a caller that stops waiting, so
 * leaving the sheet does not stop it, and its answer still fills the cache.
 */
export async function readCastSheet(
  queryClient: QueryClient,
  characterId: string,
  settings: Settings,
  force: boolean,
): Promise<CastReadFailure | null> {
  const model = castModelOf(settings);
  if (model === null) return "no_model";
  const reasoning = castReasoningOf(settings);
  const outcome = await ensureCastSheet(
    characterId,
    { model, ...(reasoning === null ? {} : { reasoning }), ...(force ? { force } : {}) },
    new AbortController().signal,
  );
  if (!outcome.ok) return outcome.reason;
  const { sheet, current } = outcome;
  queryClient.setQueryData<CastSheetResponse>(CAST_SHEET_KEY(characterId), { sheet, current });
  return null;
}

/**
 * The character sheet's Cast section: the people the card names, by name and
 * age, as the cast sheet read them, and what the sheet is for; the way to
 * read it when there is none, to read it again once the card changed, and
 * a quiet Regenerate while it is current. A character not yet saved has no
 * cast sheet.
 */
export function CastSection({ id, name }: { id: string | null; name: string }) {
  return (
    <section id="s-cast" aria-labelledby="cast-heading" className={SHEET_GRID}>
      <h2 id="cast-heading" className={sheetLabel("text")}>
        Cast
      </h2>
      {id === null ? (
        <p className={HELP}>The cast is read from the card once {name} is saved.</p>
      ) : (
        <CastSheetControls id={id} />
      )}
    </section>
  );
}

/** The sheet once loaded: while it loads, or after it failed to (with a way to load it again), nothing. */
function CastSheetControls({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const sheet = useQuery(castSheetQuery(id));
  const read = useMutation({
    // Settings as they are at the click, so a model changed meanwhile counts.
    mutationFn: (force: boolean) => readCastSheet(queryClient, id, currentSettings(), force),
  });
  const { data } = sheet;
  if (data === undefined) {
    return sheet.isError ? (
      <div role="alert" className="grid justify-items-start gap-2">
        <p className="text-ember text-note">The cast could not be loaded.</p>
        <Button variant="outline" onClick={() => void sheet.refetch()}>
          Load the cast again
        </Button>
      </div>
    ) : (
      <div aria-busy="true" className="min-h-10" />
    );
  }
  return (
    <CastSheetView
      response={data}
      working={read.isPending}
      failure={read.data ?? null}
      onRead={(force) => read.mutate(force)}
    />
  );
}

/** What the section says of a sheet once read, in Memory's manner. */
export const CAST_KEPT =
  "Read from the card, so every chat starts with them in the cast. Kept with the character, encrypted like its card.";

/** The section's states: none yet, current, stale, reading, and a failed read. */
export function CastSheetView({
  response: { sheet, current },
  working,
  failure,
  onRead,
}: {
  response: CastSheetResponse;
  working: boolean;
  failure: CastReadFailure | null;
  /** Read the card now; `force` regenerates a sheet the card has moved past. */
  onRead: (force: boolean) => void;
}) {
  const stale = sheet !== null && !current;
  const note =
    sheet === null
      ? "No cast sheet yet. One is read from the card when a chat starts."
      : "The card changed since this was read.";
  return (
    <div className="grid gap-3">
      {sheet !== null &&
        (sheet.entries.length === 0 ? (
          <p className="text-note text-reed">The card names no one.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            {sheet.entries.map((entry) => {
              const age = ageOf(entry);
              return (
                <li key={entry.id} className="text-ink text-ui">
                  {entry.anchor.name}
                  {age !== "" && <span className="text-reed"> ({age})</span>}
                </li>
              );
            })}
          </ul>
        ))}
      {stale && <p className={HELP}>{CAST_KEPT}</p>}
      {sheet !== null && !stale && (
        // Current: what the sheet is for, and Regenerate within reach, quiet.
        <div className="flex items-start justify-between gap-4">
          <p aria-live="polite" className={cn(HELP, "max-w-measure")}>
            {working ? "Reading the card" : CAST_KEPT}
          </p>
          <Button
            variant="quiet"
            disabled={working}
            onClick={() => onRead(true)}
            className="-mt-2 -mr-3.5 shrink-0"
          >
            Regenerate the cast
          </Button>
        </div>
      )}
      {(sheet === null || stale) && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3",
            stale && "border-rush border-t pt-3",
          )}
        >
          <p aria-live="polite" className={HELP}>
            {working ? "Reading the card" : note}
          </p>
          <Button variant="outline" disabled={working} onClick={() => onRead(stale)}>
            {stale ? "Regenerate the cast" : "Read the cast now"}
          </Button>
        </div>
      )}
      {failure !== null && !working && <ReadFailure reason={failure} />}
    </div>
  );
}

/** A failed read: what went wrong and, where it is Settings, the link there. */
function ReadFailure({ reason }: { reason: CastReadFailure }) {
  const { text, action } = castReadFailure(reason);
  const look = cn(buttonVariants({ variant: "quiet" }), "h-8 px-2 text-ink text-note touch:h-11");
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      <p className="text-pretty text-ember text-note">{text}</p>
      {action === "window" ? (
        <CastWindowLink className={look} />
      ) : (
        action === "settings" && (
          <WindowLink model={null} section="memory" className={look}>
            {CAST_ACTION_LABEL.settings}
          </WindowLink>
        )
      )}
    </div>
  );
}

/** To Context, on the window field of the model cast calls go to. */
function CastWindowLink({ className }: { className: string }) {
  const model = castModelOf(useSettings());
  return (
    <WindowLink model={model} className={className}>
      {CAST_ACTION_LABEL.window}
    </WindowLink>
  );
}
