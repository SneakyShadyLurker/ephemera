import { modelIdSchema } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, useRef, useState } from "react";
import { Combobox, ComboboxItem, ComboboxPopup, ComboboxTrigger } from "@/components/ui/combobox";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/text";
import { modelsQuery } from "../api.ts";

/** The most rows a query shows; past it the status line asks for more letters. */
const SHOWN = 200;
const STATUS_LINE = "px-3 py-2";

/**
 * A model to use, by id, from `options` (`useModelOptions`), found by typing
 * part of it; a model the provider does not list can be typed whole. `lead`
 * is a first choice that is not a model ("The chat's model"), shown by its
 * label; a null value shows the placeholder.
 */
export function ModelSelect({
  labelId,
  label,
  options,
  value,
  onChange,
  lead,
  placeholder,
  disabled = false,
  finalFocus,
  className,
}: {
  options: readonly string[];
  value: string | null;
  onChange: (model: string) => void;
  lead?: { value: string; label: string };
  placeholder?: string;
  /** Held by the host (a run painting); an empty list never disables it. */
  disabled?: boolean;
  /** Where focus goes when the list closes (`ComboboxPopup`); the trigger by default. */
  finalFocus?: ComponentProps<typeof ComboboxPopup>["finalFocus"];
  className?: string;
} & ({ labelId: string; label?: never } | { label: string; labelId?: never })) {
  const models = useQuery(modelsQuery);
  const [query, setQuery] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const catalog = models.data;
  const windows = new Map((catalog ?? []).map((model) => [model.id, model.contextWindow]));

  const typed = query.trim();
  const needle = typed.toLowerCase();
  const matches =
    needle === "" ? options : options.filter((id) => id.toLowerCase().includes(needle));
  const shown = matches.slice(0, SHOWN);
  // Case alone does not make another model: "LOW" with "low" listed offers no typed row.
  const listed =
    typed === "" || [...options, ...windows.keys()].some((id) => id.toLowerCase() === needle);
  const valid = modelIdSchema.safeParse(typed).success;
  const offerTyped = !listed && valid;
  const leadShown = lead !== undefined && needle === "";
  const items = [...(leadShown ? [lead.value] : []), ...shown, ...(offerTyped ? [typed] : [])];
  const labelOf = (id: string) => (lead !== undefined && id === lead.value ? lead.label : id);

  // A failed refetch keeps the list it has; only a first load that failed says so.
  const failed = models.isError && catalog === undefined && !models.isFetching;
  const loading = catalog === undefined && !failed;
  const status = failed ? (
    <div className={cn(STATUS_LINE, "flex items-center justify-between gap-3")}>
      <span className="text-ember">The model list didn't load.</span>
      <button
        type="button"
        onClick={() => void models.refetch()}
        className="press -my-1 rounded-sm px-1.5 py-1 font-medium text-ink underline decoration-rush underline-offset-4 hover:decoration-ink touch:py-2.5"
      >
        Try again
      </button>
    </div>
  ) : loading ? (
    <p className={cn(STATUS_LINE, "text-reed")}>Loading models…</p>
  ) : catalog?.length === 0 && needle === "" ? (
    <p className={cn(STATUS_LINE, "text-pretty text-reed")}>
      The provider lists no models. Type a model ID to use one.
    </p>
  ) : matches.length > SHOWN ? (
    <p className={cn(STATUS_LINE, "text-reed tabular-nums")}>
      Showing {formatCount(SHOWN)} of {formatCount(matches.length)}. Keep typing to narrow.
    </p>
  ) : null;

  return (
    <Combobox<string>
      items={items}
      filteredItems={items}
      value={value}
      onValueChange={(chosen) => {
        if (typeof chosen === "string") onChange(chosen);
      }}
      inputValue={query}
      onInputValueChange={(next) => {
        setQuery(next);
        results.current?.scrollTo({ top: 0 });
      }}
      onOpenChange={(open) => {
        // Every opening starts from the whole list.
        if (open) setQuery("");
      }}
      itemToStringLabel={labelOf}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxTrigger
        {...(labelId === undefined ? { "aria-label": label } : { "aria-labelledby": labelId })}
        className={cn("w-full max-w-72 tablet:w-64", className)}
      >
        {value === null ? (
          <span className="text-reed">{placeholder ?? lead?.label ?? "Choose a model"}</span>
        ) : (
          labelOf(value)
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        {...(finalFocus === undefined ? {} : { finalFocus })}
        label="Models"
        find={{ label: "Find a model", placeholder: "Find a model or type its ID" }}
        status={status}
        results={results}
        footer={
          offerTyped && (
            <ComboboxItem
              value={typed}
              index={items.length - 1}
              detail={catalog === undefined ? "Typed model ID" : "Not on the provider's list"}
              describe={catalog === undefined ? "Typed model ID" : "Not on the provider's list"}
            >
              <span className="text-reed">Use "</span>
              {typed}
              <span className="text-reed">"</span>
            </ComboboxItem>
          )
        }
        after={
          !listed &&
          !valid && <p className="text-meta text-reed">Model IDs are at most 200 characters.</p>
        }
      >
        {leadShown && (
          <ComboboxItem value={lead.value} index={0}>
            {lead.label}
          </ComboboxItem>
        )}
        {shown.map((id, index) => {
          const window = windows.get(id) ?? null;
          return (
            <ComboboxItem
              key={id}
              value={id}
              index={index + (leadShown ? 1 : 0)}
              aside={window === null ? undefined : formatCount(window)}
              describe={
                window === null ? undefined : `Context window ${formatCount(window)} tokens`
              }
            >
              {id}
            </ComboboxItem>
          );
        })}
      </ComboboxPopup>
    </Combobox>
  );
}
