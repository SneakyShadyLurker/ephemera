import { Link, linkOptions } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { BackIcon } from "@/components/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useFormFactor } from "./form-factor.ts";

export type BackTarget =
  | { to: "/characters" | "/personas" | "/lorebooks" | "/presets"; label: string }
  | { to: "/characters/$id"; id: string; label: string }
  | { to: "/"; label: "Chat" }
  | { label: string; onBack: () => void; iconOnly?: boolean };

/** Back links and local back steps keep their existing destinations and accessible names. */
export function BackControl({ back }: { back: BackTarget }) {
  const phone = useFormFactor() === "phone";
  if ("onBack" in back) {
    return back.iconOnly ? (
      <Button size="icon" aria-label={`Back to ${back.label.toLowerCase()}`} onClick={back.onBack}>
        <BackIcon />
      </Button>
    ) : (
      <Button className="pl-2 max-tablet:-ml-1" onClick={back.onBack}>
        <BackIcon size={16} />
        {back.label}
      </Button>
    );
  }
  if (back.to === "/") {
    return (
      <Link
        to="/"
        aria-label="Back to chat"
        className={cn(buttonVariants(), "pl-2 max-tablet:-ml-1")}
      >
        <BackIcon size={16} />
        {back.label}
      </Link>
    );
  }
  const spoken = back.to === "/characters/$id" ? back.label : back.label.toLowerCase();
  const link =
    back.to === "/characters/$id"
      ? linkOptions({ to: back.to, params: { id: back.id } })
      : linkOptions({ to: back.to });
  return phone ? (
    <Link {...link} aria-label={`Back to ${spoken}`} className={buttonVariants({ size: "icon" })}>
      <BackIcon />
    </Link>
  ) : (
    <Link {...link} className={cn(buttonVariants(), "max-w-56 pl-2")}>
      <BackIcon size={16} />
      <span className="truncate">{back.label}</span>
    </Link>
  );
}

/** Screen and sheet controls align with the same body frame and tablet inset. */
export function HeaderFrame({
  frame,
  gutters,
  edge,
  children,
}: {
  frame?: string | undefined;
  gutters?: string | undefined;
  edge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <header className="header-hairline sticky top-0 box-content flex h-14 shrink-0 border-b pt-[env(safe-area-inset-top)]">
      <div className={cn("flex min-w-0 flex-1", gutters && cn("overflow-hidden", gutters))}>
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1",
            frame ?? "tablet:px-6",
            "max-tablet:px-2",
          )}
        >
          {children}
        </div>
      </div>
      {edge}
    </header>
  );
}

export function HeaderTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      className={cn(
        "min-w-0 flex-1 truncate px-2 font-semibold text-heading text-ink outline-none tablet:px-0",
        className,
      )}
      {...props}
    />
  );
}

export function HeaderActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center gap-1", className)} {...props} />;
}
