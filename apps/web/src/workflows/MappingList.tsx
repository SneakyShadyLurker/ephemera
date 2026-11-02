import { useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { MappingRow } from "./mapping.ts";
import { NodeLabel } from "./OtherNodes.tsx";
import type { ChoicePlace } from "./panel-state.ts";

/*
 * Where Ephemera's values go: four stacked places on one static rail. Each
 * names the nodes it fills and their inputs, the value the file holds and
 * what Ephemera does with it. A place detection could not settle asks for
 * its node on a dashed rail. No connector, arrow or order is drawn: the rail
 * only gathers the places.
 */

const PLACES = ["Prompt", "Size and count", "Seed", "Image output"] as const;

/**
 * Each row's grid: the place name over its nodes on phones, where a label
 * column would leave the nodes a sliver; from tablets on, the name in the
 * import panel's label column (ImportPanel's FIELD_ROW), then its nodes.
 */
const ROW =
  "relative grid gap-y-1 py-2.5 pl-4 tablet:grid-cols-[7rem_minmax(0,1fr)] tablet:gap-x-3";

/** A note line that fades in again whenever its text changes after a choice. */
const CHANGING =
  "text-pretty text-note transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0";

/** The rail's part beside one row: solid rush, dashed control edge while the row waits. */
function Rail({ waiting = false }: { waiting?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-y-0 left-0 border-l",
        waiting ? "border-control-edge border-dashed" : "border-rush",
      )}
    />
  );
}

function Heading({ id }: { id: string }) {
  return (
    <h4 id={id} className="font-medium text-ink text-ui">
      Ephemera fills these four places
    </h4>
  );
}

/** The four places as hairline outlines while the file is read; nothing shimmers. */
export function MappingOutline() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <Heading id={headingId} />
      <ul aria-label="Where Ephemera's values go" className="grid">
        {PLACES.map((place) => (
          <li key={place} className={ROW}>
            <Rail />
            <span className="text-reed text-ui">{place}</span>
            <span aria-hidden="true" className="grid gap-1.5 py-0.5">
              <span className="block h-4 w-3/5 rounded-sm border border-rush" />
              <span className="block h-3 w-2/5 rounded-sm border border-rush" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MappingList({
  rows,
  disabled,
  onChoose,
}: {
  rows: MappingRow[];
  disabled: boolean;
  onChoose: (place: ChoicePlace, node: string) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-2 arrive">
      <Heading id={headingId} />
      <ul aria-label="Where Ephemera's values go" className="grid">
        {rows.map((row) => {
          const { choice } = row;
          const waiting = choice !== null && choice.value === null;
          const chosen = choice?.options.find((option) => option.value === choice.value);
          return (
            <li key={row.place} data-place={row.place} className={ROW}>
              <Rail waiting={waiting} />
              <span className="text-pretty text-reed text-ui">{row.label}</span>
              <div className="grid min-w-0 justify-items-start gap-1">
                {waiting && <p className="text-pretty text-note text-reed">{choice.ask}</p>}
                {choice !== null ? (
                  <Select
                    value={choice.value}
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (typeof value === "string") onChoose(choice.place, value);
                    }}
                  >
                    <SelectTrigger
                      aria-label={choice.label}
                      placeholder="Choose a node"
                      className="max-w-sm"
                    >
                      {chosen === undefined ? undefined : (
                        <span className="min-w-0 flex-1 truncate">
                          <NodeLabel title={chosen.title} node={chosen.value} />
                        </span>
                      )}
                    </SelectTrigger>
                    <SelectContent label={choice.label} className="min-w-72">
                      {choice.options.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          description={option.description}
                        >
                          {option.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  row.targets.map((target) => (
                    <p
                      key={target.node}
                      className="text-pretty break-words text-ink text-ui transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
                    >
                      <NodeLabel title={target.title} node={target.node} />
                      {target.inputs.length > 0 && `, ${target.inputs.join(", ")}`}
                    </p>
                  ))
                )}
                {choice?.problem != null && (
                  <p role="alert" className="text-pretty text-ember text-note">
                    {choice.problem}
                  </p>
                )}
                {!waiting && (
                  <>
                    {row.inFile !== null && (
                      <p
                        key={`file:${row.inFile}`}
                        className={cn(CHANGING, "break-words text-reed")}
                      >
                        In this file: {row.inFile}
                      </p>
                    )}
                    <p key={`does:${row.does}`} className={cn(CHANGING, "text-reed")}>
                      {row.does}
                    </p>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
