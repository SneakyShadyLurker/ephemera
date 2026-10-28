import { type ReactNode, useId } from "react";

/** A sheet control under its small label, with an optional note beneath; the label names the control. */
export function Labelled({
  label,
  note,
  children,
}: {
  label: string;
  note?: ReactNode;
  children: (labelId: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-1">
      <span id={id} className="text-meta text-reed">
        {label}
      </span>
      {children(id)}
      {note && <span className="text-meta text-reed">{note}</span>}
    </div>
  );
}
