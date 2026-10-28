import { CheckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { NoticeCard } from "../app/NoticeCard.tsx";
import type { SignInPhase } from "./signin.ts";

/** What the tab has waiting for the session to come back; it picks the notice's body. */
export type Waiting = "send" | "edits" | "nothing";

const KEPT: Record<Waiting, string> = {
  send: "Your message is kept and sends by itself once you're signed in.",
  edits: "Your edits are kept in this tab and save by themselves once you're signed in.",
  nothing: "Your chat is kept in this tab.",
};

const DONE: Record<Waiting, string> = {
  send: "Your message was sent; the reply is on its way.",
  edits: "Your edits are saved.",
  nothing: "You can carry on in this tab.",
};

const STILL: Record<Waiting, string> = {
  send: "Your message is still kept. Sign in again and it sends by itself.",
  edits: "Your edits are still kept. Sign in again and they save by themselves.",
  nothing: "Your chat is still kept. Sign in again to carry on.",
};

function copy(phase: Exclude<SignInPhase, "active">, waiting: Waiting) {
  switch (phase) {
    case "expired":
      return {
        title: "Your sign-in has expired",
        body: `${KEPT[waiting]} Sign in opens a new window; this tab stays as it is.`,
      };
    case "waiting":
      return {
        title: "Waiting for you to sign in",
        body: "Finish in the other window. This tab picks up on its own; no need to reload.",
      };
    case "renewed":
      return { title: "Signed in again", body: DONE[waiting] };
    case "still-expired":
      return { title: "Still signed out", body: STILL[waiting] };
  }
}

/**
 * The calm notice for an expired Authelia session. `dock` sits in the
 * composer's slot of the script grid; `float` is the last row of a sheet's
 * field column, sticky at the bottom.
 */
export function SignInNotice({
  phase,
  waiting,
  placement,
  onSignIn,
}: {
  phase: SignInPhase;
  waiting: Waiting;
  placement: "dock" | "float";
  onSignIn: () => void;
}) {
  if (phase === "active") return null;
  const { title, body } = copy(phase, waiting);
  const action =
    phase === "renewed" ? null : phase === "waiting" ? "Open sign-in again" : "Sign in";
  return (
    <NoticeCard
      data-signin={phase}
      placement={placement}
      swapKey={phase}
      title={
        <>
          {phase === "renewed" && <CheckIcon size={16} className="shrink-0 text-reed" />}
          {title}
          {phase === "waiting" && <span aria-hidden="true" className="caret" />}
        </>
      }
      body={body}
      actions={
        action && (
          <Button variant="outline" className="px-2.5" onClick={onSignIn}>
            {action}
          </Button>
        )
      }
    />
  );
}
