import {
  type ComponentProps,
  createContext,
  type ReactNode,
  use,
  useEffect,
  useState,
} from "react";
import type { SaveStatus } from "./autosave.ts";
import { InlineSave } from "./InlineSave.tsx";

export const FieldSaving = createContext<{ status: SaveStatus; noun: string } | null>(null);

/** Each authoring field remembers its own save, even while another field is edited. */
export function FieldFeedback({ value, children }: { value: unknown; children: ReactNode }) {
  const saving = use(FieldSaving);
  const [previous, setPrevious] = useState(() => value);
  const [changed, setChanged] = useState(false);
  const [pending, setPending] = useState(false);
  const changing = !Object.is(previous, value);
  useEffect(() => {
    if (Object.is(previous, value)) return;
    setPrevious(() => value);
    setChanged(true);
    setPending(true);
  }, [previous, value]);
  useEffect(() => {
    if (saving?.status.kind === "saved") setPending(false);
  }, [saving?.status]);
  if (saving === null) return children;
  return (
    <span className="grid min-w-0 gap-1">
      {children}
      <span className="min-h-5">
        {(changed || changing) && (
          <InlineSave
            status={pending || changing ? saving.status : { kind: "saved" }}
            noun={saving.noun}
          />
        )}
      </span>
    </span>
  );
}

export function AuthoringField(props: ComponentProps<"textarea">) {
  return (
    <FieldFeedback value={props.value}>
      <textarea {...props} />
    </FieldFeedback>
  );
}

export function AuthoringInput(props: ComponentProps<"input">) {
  return (
    <FieldFeedback value={props.value}>
      <input {...props} />
    </FieldFeedback>
  );
}
