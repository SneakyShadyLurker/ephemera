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

/** A gallery's tile: the portrait, the name and one quiet caption line; it opens the sheet. */
export function PortraitTile({
  owner,
  id,
  name,
  version,
  caption,
  arriving = false,
  transition,
  onOpen,
}: {
  owner: PortraitOwner;
  id: string;
  name: string;
  version: number | null;
  caption: ReactNode;
  arriving?: boolean;
  /** Carries the portrait morph to and from the sheet. */
  transition: boolean;
  onOpen: () => void;
}) {
  return (
    <Link
      to={owner === "characters" ? "/characters/$id" : "/personas/$id"}
      params={{ id }}
      onClick={onOpen}
      className="group grid gap-2.5 rounded-lg outline-offset-4"
    >
      <Portrait
        owner={owner}
        id={id}
        version={version}
        arriving={arriving}
        transition={transition}
        className="transition-[filter] duration-(--duration-tint) group-hover:brightness-[1.04] group-active:brightness-95"
      />
      <span className="grid gap-0.5 px-0.5">
        <span className="line-clamp-2 text-pretty break-words font-semibold text-ink text-lead decoration-control-edge underline-offset-4 group-hover:underline">
          {name}
        </span>
        <span className="min-h-4 truncate text-meta text-reed">{caption}</span>
      </span>
    </Link>
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
