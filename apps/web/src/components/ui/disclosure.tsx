import { ChevronDownIcon } from "@/components/icons";
import { cn } from "@/lib/cn";

/**
 * The chevron of a native disclosure's summary (styles.css
 * `disclosure-chevron`): it turns as its `<details>` opens, on the spring,
 * and at once under reduced motion. It points down and turns up; a caller
 * may set `--chevron-closed` and `--chevron-open` for other angles.
 */
export function DisclosureChevron({ className }: { className?: string }) {
  return <ChevronDownIcon size={16} className={cn("disclosure-chevron shrink-0", className)} />;
}
