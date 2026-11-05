import { type ComponentProps, useRef, useState } from "react";
import { EditIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** The open prose face keeps a quiet editing cue even before focus. */
export function ProseField({
  className,
  readOnly,
  ref,
  onFocus,
  onBlur,
  onPointerDown,
  onKeyDown,
  ...props
}: ComponentProps<"textarea">) {
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const settledFocus = useRef(false);
  const finish = () => {
    const node = field.current;
    if (!node) return;
    node.blur();
    settledFocus.current = true;
    node.focus({ preventScroll: true });
  };
  return (
    <span className="relative grid min-w-0 w-full">
      <textarea
        {...props}
        ref={(element) => {
          field.current = element;
          if (typeof ref === "function") return ref(element);
          if (ref) ref.current = element;
        }}
        readOnly={readOnly || !editing}
        onPointerDown={(event) => {
          if (!readOnly) setEditing(true);
          onPointerDown?.(event);
        }}
        onFocus={(event) => {
          if (!readOnly && !settledFocus.current) setEditing(true);
          settledFocus.current = false;
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setEditing(false);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!readOnly && !editing) setEditing(true);
            else finish();
            return;
          }
          onKeyDown?.(event);
        }}
        className={cn(
          className,
          "pr-8",
          !editing && "border-transparent bg-transparent shadow-none",
          !readOnly && "read-only:cursor-text",
        )}
      />
      {!readOnly && (
        <EditIcon size={16} className="pointer-events-none absolute top-2 right-2 text-reed" />
      )}
      {editing && !readOnly && (
        <Button
          variant="outline"
          className="mt-1 hidden justify-self-start font-sans touch:inline-flex"
          onPointerDown={(event) => event.preventDefault()}
          onClick={finish}
        >
          Done
        </Button>
      )}
    </span>
  );
}
