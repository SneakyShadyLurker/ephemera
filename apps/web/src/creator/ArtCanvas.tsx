import { type CSSProperties, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A candidate portrait drawn from its decoded bitmap onto a canvas sized for
 * the device's pixel ratio, filled from the top like every portrait. It draws
 * before paint, so a view transition captures the new image. The canvas is
 * cleared when the bitmap is replaced and on unmount; the bitmap's owner
 * closes it. `label` is its alternative text; without one it is decorative.
 */
export function ArtCanvas({
  bitmap,
  label,
  className,
  style,
}: {
  bitmap: ImageBitmap;
  label?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * ratio);
      const height = Math.round(element.clientHeight * ratio);
      if (width === 0 || height === 0) return;
      element.width = width;
      element.height = height;
      const context = element.getContext("2d");
      if (context === null) return;
      context.imageSmoothingQuality = "high";
      const scale = Math.max(width / bitmap.width, height / bitmap.height);
      const drawn = { width: bitmap.width * scale, height: bitmap.height * scale };
      context.drawImage(bitmap, (width - drawn.width) / 2, 0, drawn.width, drawn.height);
    };
    draw();
    const resized = new ResizeObserver(draw);
    resized.observe(element);
    return () => {
      resized.disconnect();
      // A zero-sized canvas holds no pixels.
      element.width = 0;
      element.height = 0;
    };
  }, [bitmap]);

  return (
    <canvas
      ref={canvas}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      style={style}
      className={cn("block size-full", className)}
    />
  );
}
