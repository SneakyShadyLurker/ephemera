import { useState } from "react";
import { NoticeCard } from "@/app/NoticeCard.tsx";
import { Button } from "@/components/ui/button";
import { useBehindServer } from "./build.ts";

/**
 * Ephemera was deployed again while this tab was open: its code is the
 * earlier build's, which can fail to read what the new server sends. The
 * notice floats over the top of the content column until reloaded or
 * dismissed; a reload meets the chat's own leave guard.
 */
export function UpdateFloat() {
  const behind = useBehindServer();
  const [dismissed, setDismissed] = useState(false);
  if (!behind || dismissed) return null;
  return (
    <div className="pointer-events-auto w-full max-w-notice">
      <NoticeCard
        placement="float"
        data-update-notice=""
        title="Ephemera was updated"
        body="This tab still runs the earlier version, so some things may not load. Reload to use the new one; a reload ends the chat."
        actions={
          <>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button onClick={() => setDismissed(true)}>Dismiss</Button>
          </>
        }
      />
    </div>
  );
}
