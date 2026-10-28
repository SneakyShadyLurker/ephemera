import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/cn";

/**
 * A model to use, by id, from `options` (`useModelOptions`). `lead` is a
 * first choice that is not a model ("The chat's model"), shown by its
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
  className,
}: {
  options: readonly string[];
  value: string | null;
  onChange: (model: string) => void;
  lead?: { value: string; label: string };
  placeholder?: string;
  /** Held by the host beyond an empty list (a run painting). */
  disabled?: boolean;
  className?: string;
} & ({ labelId: string; label?: never } | { label: string; labelId?: never })) {
  const items = {
    ...(lead === undefined ? {} : { [lead.value]: lead.label }),
    ...Object.fromEntries(options.map((id) => [id, id])),
  };
  return (
    <Select
      value={value}
      items={items}
      disabled={disabled || (lead === undefined && options.length === 0)}
      onValueChange={(chosen) => {
        if (typeof chosen === "string") onChange(chosen);
      }}
    >
      <SelectTrigger
        {...(labelId === undefined ? { "aria-label": label } : { "aria-labelledby": labelId })}
        placeholder={placeholder ?? lead?.label ?? "Choose a model"}
        className={cn("w-full max-w-72 tablet:w-64", className)}
      />
      <SelectContent label="Models" className="min-w-64">
        {lead && <SelectItem value={lead.value}>{lead.label}</SelectItem>}
        {options.map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
