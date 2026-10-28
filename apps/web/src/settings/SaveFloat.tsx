import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { NoticeCard } from "@/app/NoticeCard.tsx";
import { Button } from "@/components/ui/button";
import { sentence } from "@/lib/text";
import { useNotReached, useSignInPhase } from "../signin/hooks.ts";
import { retryFailedSettings, useFailedSettingsSave, useRefusedSettingsSave } from "./settings.ts";

/**
 * A settings save the server did not take, wherever the choice was made (the
 * Session panel, the theme switch, a persona's Default, Start chat). It floats
 * over the top of the content column; the Settings screen says it inline, and
 * while signed out the sign-in notice speaks for it (the renewal resends).
 */
export function SettingsSaveFloat() {
  const failed = useFailedSettingsSave();
  const refused = useRefusedSettingsSave();
  const notReachedText = useNotReached();
  const signedIn = useSignInPhase() === "active";
  const onSettings = useRouterState({ select: (state) => state.location.pathname === "/settings" });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const shown = failed ? `failed:${JSON.stringify(failed)}` : refused ? "refused" : null;
  if (shown === null || shown === dismissed || onSettings || !signedIn) return null;
  return (
    <div className="pointer-events-auto w-full max-w-notice">
      <NoticeCard
        role="alert"
        placement="float"
        swapKey={shown}
        title="A choice was not saved"
        body={
          failed
            ? `${sentence(notReachedText)}. This tab keeps your choice; a reload would not.`
            : "A character, persona, preset or portrait workflow chosen no longer exists. This tab keeps the choice until you pick another."
        }
        actions={
          <>
            {failed && (
              <Button variant="outline" onClick={() => void retryFailedSettings()}>
                Try again
              </Button>
            )}
            <Button onClick={() => setDismissed(shown)}>Dismiss</Button>
          </>
        }
      />
    </div>
  );
}
