import { Link } from "@tanstack/react-router";
import { NoticeCard } from "@/app/NoticeCard.tsx";
import { setSessionOpen } from "@/app/ui.ts";
import { Button, buttonVariants } from "@/components/ui/button";
import { useContextWindow } from "../api.ts";
import { useSettings } from "../settings/settings.ts";
import { SCRIPT_FRAME } from "./frame.ts";

/**
 * Sending is blocked when the chosen model has no known context window: the
 * catalog reports none and the owner set none (PRODUCT.md § Models). Says why
 * and offers both ways out, above the composer.
 */
export function WindowNotice() {
  const settings = useSettings();
  const { model } = settings;
  const window = useContextWindow(model, settings);
  if (model === null || window !== null) return null;
  return (
    <div className={`${SCRIPT_FRAME} shrink-0 pb-2`}>
      <NoticeCard
        placement="dock"
        swapKey={model}
        title="Context window unknown"
        body={`${model} has no known context window, so the prompt can't be sized. Set one for it, or choose another model.`}
        actions={
          <>
            <Link
              to="/settings"
              className={buttonVariants({ variant: "outline", className: "px-2.5" })}
            >
              Set a context window
            </Link>
            <Button className="px-2.5" onClick={() => setSessionOpen(true)}>
              Choose a model
            </Button>
          </>
        }
      />
    </div>
  );
}
