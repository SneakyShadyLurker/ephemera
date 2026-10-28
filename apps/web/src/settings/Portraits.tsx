import { settingsSchema } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { queryClient } from "@/app/query.ts";
import { cn } from "@/lib/cn";
import { ART_STATUS_KEY, artStatusQuery, artWorkflowsQuery } from "../creator/queries.ts";
import { FOCUS_WITHIN } from "../sheet/fields.ts";
import { useNotReached } from "../signin/hooks.ts";
import { portraitStatusLine } from "./portraits.ts";
import {
  applySettings,
  queueSettingsSave,
  type SaveError,
  useRefusedAddress,
  useSetting,
} from "./settings.ts";

const HELP = "text-pretty text-note text-reed";
const addressSchema = settingsSchema.shape.comfyuiBaseUrl;

/**
 * Saves the ComfyUI address and takes it into this tab only once the server
 * has not refused its origin, and only while it is still the field's newest
 * choice (`latest`): a save that settles after a newer one was committed
 * leaves the tab's copy to that one.
 */
async function saveAddress(
  comfyuiBaseUrl: string,
  latest: () => boolean,
): Promise<"taken" | "not_allowed" | "superseded"> {
  const notAllowed = await queueSettingsSave({ comfyuiBaseUrl }).then(
    () => false,
    (error: unknown) =>
      error instanceof Error &&
      error.message === ("comfyui_origin_not_allowed" satisfies SaveError),
  );
  if (!latest()) return "superseded";
  if (notAllowed) return "not_allowed";
  applySettings({ comfyuiBaseUrl });
  await queryClient.invalidateQueries({ queryKey: ART_STATUS_KEY });
  return "taken";
}

/** What the address field reports under itself, if anything. */
const ADDRESS_PROBLEMS = {
  format: "Use a plain http or https address, such as http://comfyui.local:8188.",
  not_allowed:
    "This server does not allow that address. Only origins in its COMFYUI_ALLOWED_ORIGINS can be used.",
} as const;

/**
 * The owner's ComfyUI for card portraits: its address and whether it can
 * paint now. The workflow is chosen where portraits are made, in Create with AI.
 */
export function Portraits() {
  const comfyuiBaseUrl = useSetting((settings) => settings.comfyuiBaseUrl);
  return (
    <div className="grid gap-6">
      <AddressField saved={comfyuiBaseUrl} />
      <PortraitStatus />
    </div>
  );
}

function AddressField({ saved }: { saved: string }) {
  const id = useId();
  const [address, setAddress] = useState(saved);
  const [problem, setProblem] = useState<keyof typeof ADDRESS_PROBLEMS | null>(null);
  const [editing, setEditing] = useState(false);
  // The saved address the field last took in. When it changes (this field's
  // save settling, another tab, a refetch), the field refills unless the owner
  // is typing in it, so text typed while a save is in flight stays.
  const [taken, setTaken] = useState(saved);
  if (saved !== taken) {
    setTaken(saved);
    if (!editing) {
      setAddress(saved);
      setProblem(null);
    }
  }
  // The newest address committed and not yet settled, compared against in its
  // place: reverting to the saved address while a save is in flight is a choice too.
  const [committed, setCommitted] = useState<string | null>(null);
  const round = useRef(0);
  // A resend after a renewal can be refused too, for an address the tab already holds.
  const refused = useRefusedAddress();
  const shown = problem ?? (refused !== undefined && refused === saved ? "not_allowed" : null);
  const invalid = shown !== null;
  const commit = () => {
    const next = address.trim();
    if (next === (committed ?? saved)) {
      setProblem(null);
      return;
    }
    if (!addressSchema.safeParse(next).success) {
      setProblem("format");
      return;
    }
    setProblem(null);
    setCommitted(next);
    round.current += 1;
    const mine = round.current;
    void saveAddress(next, () => round.current === mine).then((outcome) => {
      if (outcome === "superseded") return;
      setCommitted(null);
      if (outcome === "not_allowed") setProblem("not_allowed");
    });
  };
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="font-medium text-ink text-ui">
        ComfyUI address
      </label>
      <div
        className={cn(
          "flex h-9 max-w-sm items-center rounded-md border border-control-edge bg-surface px-3 touch:h-11",
          FOCUS_WITHIN,
          invalid && "border-ember",
        )}
      >
        <input
          id={id}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          translate="no"
          placeholder="http://comfyui.local:8188"
          aria-invalid={invalid}
          aria-describedby={`${id}-help`}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-ink text-ui outline-none placeholder:text-reed"
        />
      </div>
      <p id={`${id}-help`} aria-live="polite" className={cn(HELP, invalid && "text-ember")}>
        {shown !== null
          ? ADDRESS_PROBLEMS[shown]
          : "Saved when you leave the field; empty turns portraits off. Only the image prompt for a new card goes there; its token stays in the server's environment."}
      </p>
    </div>
  );
}

/** The live status line: asked when Settings opens and after each change here. */
function PortraitStatus() {
  const comfyuiWorkflow = useSetting((settings) => settings.comfyuiWorkflow);
  const status = useQuery(artStatusQuery(comfyuiWorkflow));
  const workflow = useQuery(artWorkflowsQuery).data?.find(
    (option) => option.id === comfyuiWorkflow,
  );
  const notReached = useNotReached();
  if (status.isPending) {
    return (
      <p role="status" className="text-note text-reed">
        Checking ComfyUI…
      </p>
    );
  }
  if (status.isError) {
    return (
      <p role="status" className="text-note text-reed">
        The status could not be checked: {notReached}.
      </p>
    );
  }
  const line = portraitStatusLine(status.data);
  return (
    <div role="status" className="grid gap-2">
      <p className="flex items-baseline gap-2 text-note">
        <StatusDot tone={line.tone} />
        <span className={line.tone === "problem" ? "text-ember" : "text-ink"}>{line.text}</span>
      </p>
      {line.missing && (
        <dl className="grid gap-1.5 border-rush border-l pl-4 text-note">
          {line.missing.nodes.length > 0 && (
            <div className="grid gap-0.5">
              <dt className="text-reed">Nodes</dt>
              <dd className="break-words text-ink">{line.missing.nodes.join(", ")}</dd>
            </div>
          )}
          {line.missing.models.length > 0 && (
            <div className="grid gap-0.5">
              <dt className="text-reed">Model files</dt>
              <dd className="break-words text-ink">{line.missing.models.join(", ")}</dd>
            </div>
          )}
        </dl>
      )}
      {status.data.state !== "off" && workflow !== undefined && (
        <p className={HELP}>Checked for {workflow.name}, the workflow chosen in Create with AI.</p>
      )}
    </div>
  );
}

/** A small state dot beside the status words: lit dusk when ready, ember on a problem. */
export function StatusDot({ tone }: { tone: "ready" | "off" | "problem" | "unknown" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 translate-y-[-0.1em] rounded-full",
        tone === "ready" && "bg-dusk",
        tone === "problem" && "bg-ember",
        (tone === "off" || tone === "unknown") && "bg-control-edge",
      )}
    />
  );
}
