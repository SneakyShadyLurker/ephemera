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
      <span id={captionId} className="min-h-4 truncate px-0.5 pt-0.5 text-meta text-reed">
        {caption}
      </span>
    </>
  );
}

/** The portrait's own hover: a touch brighter, a touch darker while pressed. */
const PORTRAIT_HOVER =
  "transition-[filter] duration-(--duration-tint) ease-fade group-hover:brightness-[1.04] group-active:brightness-95";

/**
 * A gallery's tile: the portrait, the name and one quiet caption line.
 * Without `onChat` the whole tile opens the sheet. With it (a character),
 * the tile starts the chat, and Edit opens the sheet from the portrait's
 * corner: shown on hover or keyboard focus where there is a hover, always
 * shown, as its icon, on touch. Edit sits outside the tile's button, so
 * the portrait's hover and press stay the chat's own.
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
      className={PORTRAIT_HOVER}
    />
  );
  if (onChat === undefined) {
    return (
      <Link {...sheet} className="group grid rounded-lg outline-offset-4">
        {portrait}
        <TileText name={name} caption={caption} />
      </Link>
    );
  }
  return (
    <div className="group/tile grid">
      <button
        type="button"
        aria-label={`Chat with ${name}`}
        aria-describedby={captionId}
        onClick={onChat}
        className="group col-start-1 row-start-1 grid cursor-pointer rounded-lg text-start outline-offset-4"
      >
        {portrait}
        <TileText name={name} caption={caption} captionId={captionId} />
      </button>
      {/* Over the portrait's top corner; it drops in on hover and keyboard focus, and stays on touch. */}
      <div className="relative col-start-1 row-start-1 m-2 self-start justify-self-end opacity-0 transition-[opacity,translate] duration-(--duration-arrive) ease-fade -translate-y-1 group-hover/tile:translate-y-0 group-hover/tile:opacity-100 group-has-[:focus-visible]/tile:translate-y-0 group-has-[:focus-visible]/tile:opacity-100 motion-reduce:translate-y-0 touch:translate-y-0 touch:opacity-100">
        <Link
          {...sheet}
          aria-label={`Edit ${name}`}
          className={cn(
            buttonVariants({ variant: "outline", size: "text" }),
            "gap-1.5 border-rush bg-surface/85 shadow-[0_1px_3px_var(--shadow-overlay)] backdrop-blur-md hover:bg-surface",
            // Touch: the pen alone on a 36px plate, its target grown to 44px.
            "touch:size-9 touch:px-0 touch:after:absolute touch:after:-inset-1",
          )}
        >
          <EditIcon size={16} />
          <span className="touch:sr-only">Edit</span>
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
