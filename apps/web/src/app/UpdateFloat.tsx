import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { NoticeCard } from "@/app/NoticeCard.tsx";
import { Button } from "@/components/ui/button";
import { useBehindServer } from "./build.ts";

/** Dismissed for this tab's life; how many mounted screens dock the notice themselves. */
const update = createStore<{ dismissed: boolean; docks: number }>()(() => ({
  dismissed: false,
  docks: 0,
}));

/** Whether the notice shows: the tab runs an earlier build than the server's, and it was not dismissed. */
function useUpdateShown(): boolean {
  const behind = useBehindServer();
  const dismissed = useStore(update, (state) => state.dismissed);
  return behind && !dismissed;
}

/**
 * Ephemera was deployed again while this tab was open: its code is the
 * earlier build's, which can fail to read what the new server sends. Shown
 * until reloaded or dismissed; a reload meets the chat's own leave guard.
 */
function UpdateNotice({ placement }: { placement: "dock" | "float" }) {
  return (
    <NoticeCard
      placement={placement}
      data-update-notice=""
      title="Ephemera was updated"
      body="This tab still runs the earlier version, so some things may not load. Reload to use the new one; a reload ends the chat."
      actions={
        <>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
          <Button onClick={() => update.setState({ dismissed: true })}>Dismiss</Button>
        </>
      }
    />
  );
}

/**
 * Every screen but the chat: the notice floats over the bottom of the
 * content column, as the sign-in notice does, clear of the headings.
 */
export function UpdateFloat() {
  const shown = useUpdateShown();
  const docked = useStore(update, (state) => state.docks > 0);
  if (!shown || docked) return null;
  return (
    <div className="pointer-events-auto w-full max-w-notice">
      <UpdateNotice placement="float" />
    </div>
  );
}

/** The chat: the notice docks above the composer, in the slot the other notices use. */
export function UpdateDock() {
  const shown = useUpdateShown();
  useEffect(() => {
    update.setState((state) => ({ docks: state.docks + 1 }));
    return () => update.setState((state) => ({ docks: state.docks - 1 }));
  }, []);
  if (!shown) return null;
  return (
    <div className="pb-2">
      <UpdateNotice placement="dock" />
    </div>
  );
}
