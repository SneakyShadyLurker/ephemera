import { Link } from "@tanstack/react-router";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/icons";
import { Button } from "@/components/ui/button";
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

/**
 * A gallery's tile: the portrait, the name and one quiet caption line, which
 * open the sheet. An `action` (a character's Chat) takes its own cell at the
 * caption's end, outside the link, so the portrait and the name keep the
 * tile's whole width and the sheet's hover and press stay the link's own.
 */
export function PortraitTile({
  owner,
  id,
  name,
  version,
  caption,
  action,
  arriving = false,
  transition,
  onOpen,
}: {
  owner: PortraitOwner;
  id: string;
  name: string;
  version: number | null;
  caption: ReactNode;
  action?: ReactNode;
  arriving?: boolean;
  /** Carries the portrait morph to and from the sheet. */
  transition: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_auto]">
      <Link
        to={owner === "characters" ? "/characters/$id" : "/personas/$id"}
        params={{ id }}
        onClick={onOpen}
        className="group col-span-full row-span-full grid grid-cols-subgrid grid-rows-subgrid rounded-lg outline-offset-4"
      >
        <Portrait
          owner={owner}
          id={id}
          version={version}
          arriving={arriving}
          transition={transition}
          className="col-span-full transition-[filter] duration-(--duration-tint) ease-fade group-hover:brightness-[1.04] group-active:brightness-95"
        />
        <span className="col-span-full line-clamp-2 text-pretty break-words px-0.5 pt-2.5 font-semibold text-ink text-lead decoration-control-edge underline-offset-4 group-hover:underline">
          {name}
        </span>
        <span className="col-start-1 min-h-4 truncate px-0.5 pt-0.5 text-meta text-reed">
          {caption}
        </span>
      </Link>
      {/* Centred on the caption's line, its hover surface ending with the portrait. */}
      {action && <div className="col-start-2 row-start-3 -mt-1.5 pl-1 touch:-mt-3">{action}</div>}
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
