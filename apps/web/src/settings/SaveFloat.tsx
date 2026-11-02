import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { NoticeCard, NoticeSlot } from "@/app/NoticeCard.tsx";
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
  const key = failed ? `failed:${JSON.stringify(failed)}` : refused ? "refused" : null;
  const live =
    key === null || key === dismissed || onSettings || !signedIn
      ? null
      : {
          key,
          failed: failed !== undefined,
          body: failed
            ? `${sentence(notReachedText)}. This tab keeps your choice; a reload would not.`
            : "A character, persona, preset or portrait workflow chosen no longer exists. This tab keeps the choice until you pick another.",
        };
  return (
    <NoticeSlot value={live} className="pointer-events-auto w-full max-w-notice">
      {(shown) => (
        <NoticeCard
          role="alert"
          placement="float"
          swapKey={shown.key}
          title="A choice was not saved"
          body={shown.body}
          actions={
            <>
              {shown.failed && (
                <Button variant="outline" onClick={() => void retryFailedSettings()}>
                  Try again
                </Button>
              )}
              <Button onClick={() => setDismissed(shown.key)}>Dismiss</Button>
            </>
          }
        />
      )}
    </NoticeSlot>
  );
}
