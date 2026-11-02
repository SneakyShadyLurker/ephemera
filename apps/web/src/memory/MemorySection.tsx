import { type MemoryState, memoryIsOn } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { MemoryIcon } from "@/components/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { SwitchField } from "@/components/ui/switch";
import { useReworkLocked } from "../rework/session.ts";
import { HELP, SHEET_GRID, sheetLabel } from "../sheet/fields.ts";
import { notReached } from "../signin/signin.ts";
import { countsText, setMemoryOn } from "./memory.ts";
import { memoryOnIn, memoryQuery } from "./queries.ts";

/** Said wherever memory is offered: what it keeps, and what it never does. */
export const MEMORY_KEPT =
  "Memories are kept with the character, encrypted like its card. The chat itself is never kept. Changing persona continues this character's story under the new player name. Duplicate the character for independent memory.";

/**
 * Memory's one switch, on the sheet and the Memory screen: on for every
 * character until it is turned off here (core `memoryIsOn`). It waits for
 * the memory to load (`state` undefined) rather than guess, and says when a
 * change did not reach the server.
 */
export function MemorySwitch({
  id,
  name,
  state,
  description,
  beforeOff,
  onTurningOff,
}: {
  id: string;
  name: string;
  /** The notebook row as loaded (null: none yet, so on); undefined while it loads. */
  state: MemoryState | null | undefined;
  /** What the switch does, said under its label. */
  description?: string;
  /**
   * Before turning memory off, which closes the notebook's editor: saves its
   * edits, false when they could not be (memory then stays on).
   */
  beforeOff?: () => Promise<boolean>;
  /**
   * True from the click that turns memory off, before `beforeOff`, and false
   * again only when that failed: the notebook takes no edits meanwhile, since
   * one typed after its save would close unsaved.
   */
  onTurningOff?: (turning: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // The state a failed change left: memory still on (true) or still off (false).
  const [unchanged, setUnchanged] = useState<boolean | null>(null);
  // Memory stayed on because the notebook's edits are not saved.
  const [held, setHeld] = useState(false);
  const on = state !== undefined && memoryIsOn(state);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setUnchanged(null);
    setHeld(false);
    if (!enabled) onTurningOff?.(true);
    if (!enabled && beforeOff !== undefined && !(await beforeOff())) {
      setBusy(false);
      setHeld(true);
      onTurningOff?.(false);
      return;
    }
    const result = await setMemoryOn(queryClient, id, enabled, state ?? null);
    setBusy(false);
    setUnchanged(result.ok ? null : !enabled);
    // Turned off, the notebook closes as the cache follows; only a failed change gives it back.
    if (!enabled && !result.ok) onTurningOff?.(false);
  };
  return (
    <div className="grid gap-2">
      <SwitchField
        label="Remember the story"
        description={
          description ??
          `On for every character. ${name} remembers what happens across chats, scene by scene, as each chat grows; turned off, each chat is forgotten when it ends. ${MEMORY_KEPT}`
        }
        checked={on}
        disabled={state === undefined || busy}
        onCheckedChange={(enabled) => void toggle(enabled)}
      />
      {unchanged !== null && (
        <p role="alert" className="text-ember text-note">
          Memory is still {unchanged ? "on" : "off"}: {notReached()}.
        </p>
      )}
      {held && (
        <p role="alert" className="text-ember text-note">
          Memory is still on: the notebook's edits are not saved yet.
        </p>
      )}
    </div>
  );
}

/**
 * The character sheet's Memory section: memory on or off, how much is
 * remembered, and the way into the memory screen. A character not yet saved
 * has no memory yet; it is on once saved. The way in is off while an AI Rework holds the
 * sheet, as the lorebook's is (leaving would drop the proposal).
 */
export function MemorySection({ id, name }: { id: string | null; name: string }) {
  return (
    <section id="s-memory" aria-labelledby="memory-heading" className={SHEET_GRID}>
      <h2 id="memory-heading" className={sheetLabel("text")}>
        Memory
      </h2>
      {id === null ? (
        <p className={HELP}>
          Memory starts once {name} is saved, and stays on unless you turn it off here.{" "}
          {MEMORY_KEPT}
        </p>
      ) : (
        <MemoryControls id={id} name={name} />
      )}
    </section>
  );
}

/**
 * The switch and the way in, once the memory loaded: while it loads, or
 * after it failed to (with a way to load it again), nothing says on or off.
 */
function MemoryControls({ id, name }: { id: string; name: string }) {
  const locked = useReworkLocked();
  const memory = useQuery(memoryQuery(id));
  const { data } = memory;
  // When the sheet opened: "today" stays today while it is open.
  const [now] = useState(Date.now);
  if (data === undefined) {
    return memory.isError ? (
      <div role="alert" className="grid justify-items-start gap-2">
        <p className="text-ember text-note">Memory could not be loaded.</p>
        <Button variant="outline" onClick={() => void memory.refetch()}>
          Load memory again
        </Button>
      </div>
    ) : (
      <div aria-busy="true" className="min-h-16" />
    );
  }
  const on = memoryOnIn(memory);
  const { episodes } = data;

  return (
    <div className="grid gap-3">
      <MemorySwitch id={id} name={name} state={data.state} />
      {(on || episodes.length > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-rush border-t pt-3">
          <p className="text-ink text-ui">
            {countsText(episodes, now)}
            {!on && " Kept while memory is off."}
          </p>
          {locked ? (
            <Button variant="outline" disabled>
              <MemoryIcon size={16} />
              Open memory
            </Button>
          ) : (
            <Link
              to="/characters/$id/memory"
              params={{ id }}
              className={buttonVariants({ variant: "outline" })}
            >
              <MemoryIcon size={16} />
              Open memory
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
