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
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "size" | "aria-label"> & {
  /** The action's accessible name. */
  label: string;
  /** The words beside the icon from tablet up, when shorter than the name. */
  text?: string;
  icon: ComponentType<IconProps>;
}) {
  const phone = useFormFactor() === "phone";
  return phone ? (
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

/** The tile's name and caption under the portrait, inside whichever control opens it. */
function TileText({
  name,
  caption,
  captionId,
}: {
  name: string;
  caption: ReactNode;
  captionId?: string;
}) {
  return (
    <>
      <span className="line-clamp-2 text-pretty break-words px-0.5 pt-2.5 font-semibold text-ink text-lead decoration-control-edge underline-offset-4 group-hover:underline">
        {name}
      </span>
      <span id={captionId} className="min-h-4 break-words px-0.5 pt-0.5 text-meta text-reed">
        {caption}
      </span>
    </>
  );
}

/** The portrait's own hover: a touch brighter, a touch darker while pressed. */
const PORTRAIT_FILTER = "transition-[filter] duration-(--duration-tint) ease-fade";
const PORTRAIT_HOVER = `${PORTRAIT_FILTER} group-hover:brightness-[1.04] group-active:brightness-95`;
/** The same, answering the chat's button, whose plate lies over the portrait. */
const CHAT_PORTRAIT_HOVER = `${PORTRAIT_FILTER} group-has-[>button:hover]/tile:brightness-[1.04] group-has-[>button:active]/tile:brightness-95`;

/**
 * A gallery's tile: the portrait, the name and one quiet caption line.
 * Without `onChat` the whole tile opens the sheet. With it (a character),
 * the tile starts the chat, and Edit opens the sheet from its own place
 * trailing the name, always shown, quiet. The chat's button sits in the name's row
 * and reaches over the portrait with a plate, so Edit never lies under it
 * and the portrait's hover and press stay the chat's own.
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
      id={id}
      version={version}
      arriving={arriving}
      transition={transition}
      className={onChat === undefined ? PORTRAIT_HOVER : CHAT_PORTRAIT_HOVER}
    />
  );
  if (onChat === undefined) {
    return (
      <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-1">
        <div className="col-span-2">{portrait}</div>
        <Link
          {...sheet}
          className="group grid min-w-0 rounded-sm outline-none before:absolute before:inset-0 before:rounded-lg focus-visible:before:focus-ring"
        >
          <TileText name={name} caption={caption} />
        </Link>
        {actions && <div className="relative mt-1">{actions}</div>}
      </div>
    );
  }
  return (
    <div className="group/tile relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-1">
      <div className="col-span-2">{portrait}</div>
      <button
        type="button"
        aria-label={`Chat with ${name}`}
        aria-describedby={captionId}
        onClick={onChat}
        // The plate covers the whole tile; Edit, later and positioned, lies above it.
        className="group grid min-w-0 cursor-pointer text-start outline-none before:absolute before:inset-0 before:rounded-lg focus-visible:before:focus-ring"
      >
        <TileText name={name} caption={caption} captionId={captionId} />
      </button>
      {/* Always there, quiet in reed, so the way to the sheet is found without hovering. */}
      <div className="mt-1">
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
