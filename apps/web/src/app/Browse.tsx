import { Link } from "@tanstack/react-router";
import { type ComponentProps, type ComponentType, type ReactNode, useId } from "react";
import { EditIcon, type IconProps } from "@/components/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { Portrait } from "../portraits/Portrait.tsx";
import type { PortraitOwner } from "../portraits/queries.ts";
import { useFormFactor } from "./form-factor.ts";

/*
 * What the list screens share: a header action, a gallery's portrait tile
 * and the line said when a gallery's list could not be loaded.
 */

/** A header action: an icon button on phones, a labelled button elsewhere. */
export function HeaderAction({
  label,
  text = label,
  icon: Icon,
  labelledOnPhone = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "size" | "aria-label"> & {
  /** The action's accessible name. */
  label: string;
  /** The words beside the icon from tablet up, when shorter than the name. */
  text?: string;
  icon: ComponentType<IconProps>;
  labelledOnPhone?: boolean;
}) {
  const phone = useFormFactor() === "phone";
  return phone && !labelledOnPhone ? (
    <Button {...props} size="icon" aria-label={label}>
      <Icon />
    </Button>
  ) : (
    <Button {...props} aria-label={text === label ? undefined : label}>
      <Icon size={16} />
      {text}
    </Button>
  );
}

/** The name always takes the tile's full width, above metadata and its separate action. */
function TileName({ name }: { name: string }) {
  return (
    <span className="line-clamp-2 text-pretty break-words px-0.5 pt-2.5 font-semibold text-ink text-lead decoration-control-edge underline-offset-4 group-hover:underline">
      {name}
    </span>
  );
}

/** The portrait's own hover: a touch brighter, a touch darker while pressed. */
const PORTRAIT_FILTER = "transition-[filter] duration-(--duration-tint) ease-fade";
const PORTRAIT_HOVER = `${PORTRAIT_FILTER} group-hover:brightness-[1.04] group-active:brightness-95`;
/** The same, answering the chat's button, whose plate lies over the portrait. */
const CHAT_PORTRAIT_HOVER = `${PORTRAIT_FILTER} group-has-[>button:hover]/tile:brightness-[1.04] group-has-[>button:active]/tile:brightness-95`;
const TILE_CAPTION_ROW =
  "flex min-h-[calc(2*var(--text-meta--line-height))] min-w-0 items-center gap-1";
const TILE_CAPTION =
  "min-w-0 flex-1 line-clamp-2 text-pretty break-words px-0.5 text-meta text-reed";

/**
 * A gallery's tile: the portrait, the name and two quiet caption lines.
 * Without `onChat` the whole tile opens the sheet. With it (a character),
 * the tile starts the chat, and Edit opens the sheet from its own place
 * trailing the metadata, always shown, quiet. The portrait and name form
 * the chat target; the metadata row and Edit sit wholly below it.
 */
export function PortraitTile({
  owner,
  id,
  name,
  version,
  caption,
  onChat,
  arriving = false,
  transition,
  onOpen,
  actions,
  actionsBelow = false,
}: {
  owner: PortraitOwner;
  id: string;
  name: string;
  version: number | null;
  caption: ReactNode;
  /** Starts a chat with the character; the sheet then opens from Edit. */
  onChat?: () => void;
  arriving?: boolean;
  /** Carries the portrait morph to and from the sheet. */
  transition: boolean;
  onOpen: () => void;
  /** A persona's More menu, outside the link that opens its sheet. */
  actions?: ReactNode;
  actionsBelow?: boolean;
}) {
  const captionId = useId();
  const sheet = {
    to: owner === "characters" ? "/characters/$id" : "/personas/$id",
    params: { id },
    onClick: onOpen,
  } as const;
  const portrait = (
    <Portrait
      owner={owner}
      {...(owner === "personas" || version !== null ? { name } : {})}
      id={id}
      version={version}
      arriving={arriving}
      transition={transition}
      className={cn(
        onChat === undefined ? PORTRAIT_HOVER : CHAT_PORTRAIT_HOVER,
        owner === "personas" && version === null && "h-24 aspect-auto",
      )}
    />
  );
  if (onChat === undefined) {
    return (
      <div className={cn("grid min-w-0", actionsBelow && "content-start")}>
        <Link
          {...sheet}
          aria-describedby={actionsBelow && caption === null ? undefined : captionId}
          className="group grid min-w-0 rounded-lg"
        >
          {portrait}
          <TileName name={name} />
        </Link>
        {(!actionsBelow || caption !== null) && (
          <div className={actionsBelow ? "flex min-w-0 items-center gap-1" : TILE_CAPTION_ROW}>
            <span id={captionId} className={TILE_CAPTION}>
              {caption}
            </span>
            {!actionsBelow && actions}
          </div>
        )}
        {actionsBelow && actions && <div className="-ml-1.5 justify-self-start">{actions}</div>}
      </div>
    );
  }
  return (
    <div className="group/tile grid min-w-0">
      <button
        type="button"
        aria-label={`Chat with ${name}`}
        aria-describedby={captionId}
        onClick={onChat}
        className="group grid min-w-0 cursor-pointer rounded-lg text-start"
      >
        {portrait}
        <TileName name={name} />
      </button>
      {/* Always there, quiet in reed, so the way to the sheet is found without hovering. */}
      <div className={TILE_CAPTION_ROW}>
        <span id={captionId} className={TILE_CAPTION}>
          {caption}
        </span>
        <Link
          {...sheet}
          aria-label={`Edit ${name}`}
          className={cn(
            buttonVariants({ variant: "outline", size: "icon" }),
            "size-8 text-reed touch:size-11",
          )}
        >
          <EditIcon size={16} />
        </Link>
      </div>
    </div>
  );
}

/** A gallery whose list did not load: "Characters could not be loaded." and Try again. */
export function ListLoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mx-auto grid max-w-page justify-items-start gap-3 px-5 pt-[12dvh]">
      <p className="text-ember text-lead">{what} could not be loaded.</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
